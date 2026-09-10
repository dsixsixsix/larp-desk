import { Readable } from 'node:stream'
import { IRequest, Router } from 'itty-router'
import { AppContext } from '../http/context'
import { RateLimiter } from '../http/rateLimit'
import {
	MAX_ASSET_UPLOAD_BYTES,
	RangeNotSatisfiableError,
	isValidObjectName,
	safeContentType,
} from './store'

/**
 * Uploads and serves the images, audio and video dropped onto a board.
 *
 * Board *contents* are not here — those live in each browser's IndexedDB. These are the binary
 * assets those documents point at, which is why they need a server at all.
 *
 * Uploads are anonymous by design: a board is a local document with no owner row to authenticate
 * against, so possession of the board is the only claim there is to check, and the client cannot
 * prove it. The `?fileId=` the client appends is therefore ignored — on Cloudflare it selected a
 * Postgres write-access check that the standalone shape has no database for. The rate limit below
 * is what stands between one caller and an unbounded number of writes into the bucket.
 */
export const assetRoutes = Router<IRequest, [AppContext, string]>()

/**
 * Uploads allowed per caller: a burst large enough for a board pasted in all at once, refilling at
 * a rate no interactive use approaches.
 */
const uploads = new RateLimiter(30, 0.5)

/** Assets are content-addressed by the client's unique id, so a stored one never changes. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

const storageUnavailable = () =>
	Response.json({ error: 'Asset storage is not configured' }, { status: 503 })

assetRoutes
	.get('/uploads/:objectName', async (request, ctx) => {
		if (!ctx.assets) return storageUnavailable()
		const objectName = request.params.objectName
		if (!isValidObjectName(objectName)) {
			return Response.json({ error: 'Invalid object name' }, { status: 400 })
		}

		const range = request.headers.get('range') ?? undefined
		let object
		try {
			object = await ctx.assets.get(objectName, range)
		} catch (error) {
			if (error instanceof RangeNotSatisfiableError) {
				return new Response(null, { status: 416 })
			}
			throw error
		}
		if (!object) return Response.json({ error: 'Not found' }, { status: 404 })

		const headers = new Headers({
			'content-type': object.contentType,
			'cache-control': IMMUTABLE_CACHE_CONTROL,
			// Video and audio scrubbing sends a range request; without this the browser downloads the
			// whole file before it will play any of it.
			'accept-ranges': 'bytes',
			// The uploader does not choose this. An asset served inline that the browser decides to
			// render is the whole point; an asset that arrives as a download from our own domain is
			// not.
			'x-content-type-options': 'nosniff',
		})
		if (object.contentLength !== undefined) {
			headers.set('content-length', String(object.contentLength))
		}
		if (object.etag) headers.set('etag', object.etag)
		if (object.contentRange) headers.set('content-range', object.contentRange)

		return new Response(Readable.toWeb(object.body) as ReadableStream, {
			status: object.contentRange ? 206 : 200,
			headers,
		})
	})
	.post('/uploads/:objectName', async (request, ctx, callerIp) => {
		if (!ctx.assets) return storageUnavailable()

		// Checked before the body is touched, so a caller over budget costs us the check and nothing
		// else.
		if (!uploads.check(callerIp)) {
			return Response.json({ error: 'Too many uploads' }, { status: 429 })
		}

		const objectName = request.params.objectName
		if (!isValidObjectName(objectName)) {
			return Response.json({ error: 'Invalid object name' }, { status: 400 })
		}

		// Answered from the header before the transfer, so an oversized upload costs a header read.
		// A body that omits or understates its length is caught by the reader below.
		const declared = parseContentLength(request.headers)
		if (declared !== null && declared > MAX_ASSET_UPLOAD_BYTES) return tooLarge()

		if (await ctx.assets.exists(objectName)) {
			return Response.json({ error: 'Asset already exists' }, { status: 409 })
		}

		let body: Buffer
		try {
			body = await readCapped(request.body, MAX_ASSET_UPLOAD_BYTES)
		} catch (error) {
			if (error instanceof AssetTooLargeError) return tooLarge()
			throw error
		}

		await ctx.assets.put(objectName, body, safeContentType(request.headers))
		return Response.json({ object: objectName })
	})

class AssetTooLargeError extends Error {}

function tooLarge() {
	return Response.json(
		{ error: 'Asset is too large', maxBytes: MAX_ASSET_UPLOAD_BYTES },
		{ status: 413 }
	)
}

function parseContentLength(headers: Headers): number | null {
	const raw = headers.get('content-length')
	if (raw === null) return null
	// A malformed or negative value tells us nothing, so treat it as absent and let the byte
	// counter be the thing that decides.
	if (!/^\d+$/.test(raw.trim())) return null
	const value = Number(raw)
	return Number.isSafeInteger(value) ? value : null
}

/**
 * Reads the body, refusing it the moment it passes `maxBytes`.
 *
 * `content-length` is a claim, not a fact — it can be absent on a chunked body and it can simply
 * lie — so this count is what actually enforces the limit, and it stops reading rather than
 * accumulating a body it has already decided to reject.
 */
async function readCapped(body: ReadableStream | null, maxBytes: number): Promise<Buffer> {
	if (!body) return Buffer.alloc(0)
	const chunks: Buffer[] = []
	let seen = 0
	const reader = body.getReader()
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			const chunk = Buffer.from(value)
			seen += chunk.byteLength
			if (seen > maxBytes) throw new AssetTooLargeError()
			chunks.push(chunk)
		}
	} finally {
		reader.releaseLock()
	}
	return Buffer.concat(chunks)
}
