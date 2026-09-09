import { retry } from '@tldraw/utils'
import { IRequest } from 'itty-router'
import { notFound } from './errors'

export const MAX_R2_OBJECT_NAME_BYTES = 1024

function isTransientWorkerError(error: unknown): boolean {
	const msg = String(error)
	return /internal error|connectivity|network connection lost|service temporarily unavailable|proxy request failed|unspecified error|connection (refused|reset|timed?\s?out)/i.test(
		msg
	)
}

function isInvalidObjectNameError(error: unknown): boolean {
	const msg = String(error)
	return msg.includes('The specified object name is not valid') || msg.includes('(10020)')
}

export function isValidR2ObjectName(objectName: string): boolean {
	return (
		objectName.length > 0 && new TextEncoder().encode(objectName).length <= MAX_R2_OBJECT_NAME_BYTES
	)
}

function invalidObjectNameResponse() {
	return Response.json({ error: 'Invalid object name' }, { status: 400 })
}

/**
 * The server-side ceiling on a single asset upload.
 *
 * The product limit is the editor's `DEFAULT_MAX_ASSET_SIZE` (10MB), enforced in the browser before
 * a file is ever sent. That check is a courtesy to the user, not a boundary: nothing stops a caller
 * from POSTing straight at this worker. This is the boundary, set above the product limit so a
 * legitimate upload never meets it.
 */
export const MAX_ASSET_UPLOAD_BYTES = 25 * 1024 * 1024

/** Thrown by the limiting stream so a body that outruns the cap is answered 413, not 500. */
const ASSET_TOO_LARGE_MESSAGE = 'Asset exceeds the maximum upload size'

class AssetTooLargeError extends Error {
	constructor() {
		super(ASSET_TOO_LARGE_MESSAGE)
	}
}

function payloadTooLargeResponse() {
	return Response.json(
		{ error: 'Asset is too large', maxBytes: MAX_ASSET_UPLOAD_BYTES },
		{ status: 413 }
	)
}

function parseContentLength(headers: Headers): number | null {
	const raw = headers.get('content-length')
	if (raw === null) return null
	// A malformed or negative value tells us nothing, so treat it as absent and let the byte
	// counter below be the thing that decides.
	if (!/^\d+$/.test(raw.trim())) return null
	const value = Number(raw)
	return Number.isSafeInteger(value) ? value : null
}

/**
 * Caps the body at `maxBytes` as it streams past, without holding it.
 *
 * `content-length` is a claim, not a fact — it can be absent on a chunked body and it can simply
 * lie — so the count here is what actually enforces the limit. Streaming rather than buffering is
 * the point: an isolate has 128MB for every request it is serving at once, so buffering even a
 * bounded body lets a handful of concurrent uploads exhaust it and take unrelated requests down
 * with them.
 */
function limitBodySize(body: ReadableStream, maxBytes: number): ReadableStream {
	let seen = 0
	return body.pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				seen += (chunk as Uint8Array).byteLength
				if (seen > maxBytes) {
					controller.error(new AssetTooLargeError())
					return
				}
				controller.enqueue(chunk)
			},
		})
	)
}

/**
 * The subset of the uploader's headers we let reach R2, which is served back to every viewer of the
 * asset by {@link handleUserAssetGet}.
 *
 * Forwarding the request headers wholesale handed an uploader the response headers too: a
 * `content-disposition` of their choosing turns an asset URL into a drive-by download from our own
 * domain. Only a well-formed content type survives, and anything else becomes the type that commits
 * a browser to nothing.
 */
function safeHttpMetadata(headers: Headers): { contentType: string } {
	const contentType = headers.get('content-type')?.trim()
	// type/subtype with optional parameters, per RFC 9110 — deliberately strict, since the value
	// ends up in a response header.
	if (contentType && /^[\w.+-]+\/[\w.+-]+(\s*;[\w.+-]+\s*=\s*[^;]+)*$/.test(contentType)) {
		return { contentType }
	}
	return { contentType: 'application/octet-stream' }
}

export const TRANSIENT_RETRY_OPTIONS = {
	attempts: 3,
	waitDuration: 500,
	matchError: isTransientWorkerError,
} as const

// Minimal interface for R2Bucket operations used in this file
// This avoids type conflicts between ambient and imported Cloudflare types
// Using 'any' for return types to allow compatibility with different R2Bucket type definitions
export interface R2BucketLike {
	head(key: string): Promise<any>
	get(key: string, options?: any): Promise<any>
	put(key: string, value: any, options?: any): Promise<any>
}

// Cloudflare's caches global has a 'default' property for the default cache
declare const caches: {
	default: {
		match(request: unknown): Promise<Response | undefined>
		put(request: unknown, response: Response): Promise<void>
	}
}

/**
 * Handles asset upload requests to Cloudflare R2 storage with conflict detection.
 * Checks if the asset already exists and returns a 409 Conflict status if found,
 * otherwise streams the asset into the bucket.
 *
 * Bodies over {@link MAX_ASSET_UPLOAD_BYTES} are refused with a 413, whether or not their
 * `content-length` admits their size, and only a validated content type is carried through to the
 * stored object.
 *
 * @param options - Configuration object for the upload
 *   - objectName - Unique identifier for the asset in R2 storage
 *   - bucket - Cloudflare R2 bucket instance for storage
 *   - body - ReadableStream containing the asset data to upload
 *   - headers - HTTP headers to store as metadata with the asset
 * @returns Promise resolving to JSON response with object name and ETag, 409 if it exists, or 413
 *   if it is too large
 *
 * @example
 * ```ts
 * router.put('/assets/:objectName', async (request, env) => {
 *   const { objectName } = request.params
 *
 *   return handleUserAssetUpload({
 *     objectName,
 *     bucket: env.ASSETS_BUCKET,
 *     body: request.body,
 *     headers: request.headers,
 *   })
 * })
 * ```
 *
 * @public
 */
export async function handleUserAssetUpload({
	body,
	headers,
	bucket,
	objectName,
}: {
	objectName: string
	bucket: R2BucketLike
	body: ReadableStream | null
	headers: Headers
}): Promise<Response> {
	if (!isValidR2ObjectName(objectName)) return invalidObjectNameResponse()

	// Answered before the body is touched, so an oversized upload costs us a header read rather
	// than the transfer. A body that omits or understates its length is caught by limitBodySize.
	const declaredLength = parseContentLength(headers)
	if (declaredLength !== null && declaredLength > MAX_ASSET_UPLOAD_BYTES) {
		return payloadTooLargeResponse()
	}

	try {
		const existing = await retry(() => bucket.head(objectName), TRANSIENT_RETRY_OPTIONS)
		if (existing) {
			return Response.json({ error: 'Asset already exists' }, { status: 409 })
		}

		// Streamed rather than buffered, which costs us the retry this call used to have: a
		// ReadableStream is single-use, so a transient R2 error now reaches the client instead of
		// being absorbed here. That is the cheaper failure. Buffering held the whole body in an
		// isolate that has 128MB for every request it is serving concurrently, so a few large
		// uploads — or one larger than the isolate — killed unrelated requests alongside their own.
		const object = await bucket.put(
			objectName,
			body ? limitBodySize(body, MAX_ASSET_UPLOAD_BYTES) : null,
			{ httpMetadata: safeHttpMetadata(headers) }
		)

		return Response.json({ object: objectName }, { headers: { etag: object.httpEtag } })
	} catch (error) {
		// R2 may surface the errored stream as a failure of its own rather than propagating ours,
		// which is why the message is checked alongside the type.
		if (error instanceof AssetTooLargeError) return payloadTooLargeResponse()
		if (String(error).includes(ASSET_TOO_LARGE_MESSAGE)) return payloadTooLargeResponse()
		if (isInvalidObjectNameError(error)) return invalidObjectNameResponse()
		throw error
	}
}

/**
 * Handles asset retrieval requests from Cloudflare R2 storage with comprehensive caching and range support.
 * Provides automatic caching via Cloudflare's cache API, supports partial content requests (range headers),
 * and includes proper CORS headers for cross-origin access. Assets are cached with immutable headers
 * for optimal performance.
 *
 * @param options - Configuration object for asset retrieval
 *   - request - HTTP request containing potential range headers and cache keys
 *   - bucket - Cloudflare R2 bucket instance containing the asset
 *   - objectName - Unique identifier of the asset to retrieve
 *   - context - Execution context for background caching operations
 * @returns Promise resolving to the asset response with appropriate headers and caching
 *
 * @example
 * ```ts
 * router.get('/assets/:objectName', async (request, env, ctx) => {
 *   const { objectName } = request.params
 *
 *   return handleUserAssetGet({
 *     request,
 *     bucket: env.ASSETS_BUCKET,
 *     objectName,
 *     context: ctx,
 *   })
 * })
 * ```
 *
 * @public
 */
export async function handleUserAssetGet({
	request,
	bucket,
	objectName,
	context,
}: {
	request: IRequest
	bucket: R2BucketLike
	objectName: string
	context: ExecutionContext
}): Promise<Response> {
	if (!isValidR2ObjectName(objectName)) return invalidObjectNameResponse()

	// this cache automatically handles range responses etc.
	const cacheKey = new Request(request.url, { headers: request.headers })
	const cachedResponse = await caches.default.match(cacheKey)
	if (cachedResponse) {
		return cachedResponse
	}

	let object
	try {
		object = await retry(
			() => bucket.get(objectName, { range: request.headers, onlyIf: request.headers }),
			TRANSIENT_RETRY_OPTIONS
		)
	} catch (error) {
		if (isInvalidObjectNameError(error)) return invalidObjectNameResponse()
		throw error
	}

	if (!object) {
		return notFound()
	}

	const headers = new Headers()
	object.writeHttpMetadata(headers)

	// assets are immutable, so we can cache them basically forever:
	headers.set('cache-control', 'public, max-age=31536000, immutable')
	headers.set('etag', object.httpEtag)

	// we set CORS headers so all clients can access assets. we do this here so our `cors` helper in
	// worker.ts doesn't try to set extra cors headers on responses that have been read from the
	// cache, which isn't allowed by cloudflare.
	headers.set('access-control-allow-origin', '*')

	// Prevent XSS from user-uploaded SVGs (or any file served with an executable content-type).
	// This is critical when assets are served from the same origin as the app.
	headers.set('content-security-policy', "default-src 'none'")
	headers.set('x-content-type-options', 'nosniff')

	// cloudflare doesn't set the content-range header automatically in writeHttpMetadata, so we
	// need to do it ourselves.
	let contentRange
	if (object.range) {
		if ('suffix' in object.range) {
			const start = object.size - object.range.suffix
			const end = object.size - 1
			contentRange = `bytes ${start}-${end}/${object.size}`
		} else {
			const start = object.range.offset ?? 0
			const end = object.range.length ? start + object.range.length - 1 : object.size - 1
			if (start !== 0 || end !== object.size - 1) {
				contentRange = `bytes ${start}-${end}/${object.size}`
			}
		}
	}

	if (contentRange) {
		headers.set('content-range', contentRange)
	}

	const body = 'body' in object && object.body ? object.body : null
	const status = body ? (contentRange ? 206 : 200) : 304

	if (status === 200) {
		const [cacheBody, responseBody] = body!.tee()
		// cache the response
		context.waitUntil(
			caches.default.put(cacheKey, new Response(cacheBody as BodyInit, { headers, status }))
		)
		return new Response(responseBody as BodyInit, { headers, status })
	}

	return new Response(body as BodyInit | null, { headers, status })
}
