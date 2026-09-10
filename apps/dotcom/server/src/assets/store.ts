import type { Readable } from 'node:stream'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { S3Config } from '../config'

/** The largest object name S3 and R2 both accept, and what the client's key builder assumes. */
export const MAX_OBJECT_NAME_BYTES = 1024

/**
 * The server-side ceiling on a single asset upload.
 *
 * The product limit is the editor's `DEFAULT_MAX_ASSET_SIZE` (10MB), enforced in the browser before
 * a file is ever sent. That check is a courtesy to the user, not a boundary: nothing stops a caller
 * from POSTing straight at this server. This is the boundary, set above the product limit so a
 * legitimate upload never meets it.
 */
export const MAX_ASSET_UPLOAD_BYTES = 25 * 1024 * 1024

export interface StoredObject {
	body: Readable
	contentType: string
	contentLength: number | undefined
	etag: string | undefined
	/** Present only for a range request, as the value for `content-range`. */
	contentRange: string | undefined
}

/**
 * Asset storage over the S3 API, which is what replaced the R2 bucket binding.
 *
 * Any S3-compatible server works — MinIO, Garage and SeaweedFS were the ones this was written
 * against — because nothing here uses more than get, put and head. Path-style addressing is the
 * default (`S3_FORCE_PATH_STYLE`), since a self-hosted endpoint rarely has wildcard DNS.
 */
export class AssetStore {
	private readonly client: S3Client
	private readonly bucket: string

	constructor(config: S3Config) {
		this.client = new S3Client({
			endpoint: config.endpoint,
			region: config.region,
			forcePathStyle: config.forcePathStyle,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
		})
		this.bucket = config.bucket
	}

	async exists(key: string): Promise<boolean> {
		try {
			await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
			return true
		} catch (error) {
			if (isNotFound(error)) return false
			throw error
		}
	}

	async get(key: string, range: string | undefined): Promise<StoredObject | null> {
		try {
			const result = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range })
			)
			return {
				body: result.Body as Readable,
				contentType: result.ContentType ?? 'application/octet-stream',
				contentLength: result.ContentLength,
				etag: result.ETag,
				contentRange: result.ContentRange,
			}
		} catch (error) {
			if (isNotFound(error)) return null
			// A range that falls outside the object is a client error, not a missing object, and the
			// two lead to different statuses.
			if (isRangeNotSatisfiable(error)) throw new RangeNotSatisfiableError()
			throw error
		}
	}

	/**
	 * Writes an object. The body is buffered rather than streamed because the S3 API needs a length
	 * up front for a single-shot PUT, and {@link MAX_ASSET_UPLOAD_BYTES} is what makes that safe —
	 * the cap is applied while reading, so an oversized body is refused before it is all in memory.
	 */
	async put(key: string, body: Buffer, contentType: string): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: body,
				ContentType: contentType,
				ContentLength: body.byteLength,
			})
		)
	}
}

export class RangeNotSatisfiableError extends Error {}

function statusOf(error: unknown): number | undefined {
	return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
}

function isNotFound(error: unknown): boolean {
	const name = (error as { name?: string })?.name
	return name === 'NoSuchKey' || name === 'NotFound' || statusOf(error) === 404
}

function isRangeNotSatisfiable(error: unknown): boolean {
	return statusOf(error) === 416
}

export function isValidObjectName(objectName: string): boolean {
	if (objectName.length === 0) return false
	if (new TextEncoder().encode(objectName).length > MAX_OBJECT_NAME_BYTES) return false
	// The name lands in a URL path and an object key. A traversal segment in either is a way to
	// address something the caller was not given, so they are refused rather than normalized.
	if (objectName.includes('/') || objectName.includes('\\')) return false
	if (objectName === '.' || objectName === '..') return false
	return true
}

/**
 * The subset of the uploader's headers we let reach storage, which is served back to every viewer
 * of the asset.
 *
 * Forwarding the request headers wholesale hands an uploader the response headers too: a
 * `content-disposition` of their choosing turns an asset URL into a drive-by download from our own
 * domain. Only a well-formed content type survives, and anything else becomes the type that commits
 * a browser to nothing.
 */
export function safeContentType(headers: Headers): string {
	const contentType = headers.get('content-type')?.trim()
	// type/subtype with optional parameters, per RFC 9110 — deliberately strict, since the value
	// ends up in a response header.
	//
	// The space after `;` is what the Cloudflare version's pattern left out, so every
	// `text/plain; charset=utf-8` — the form nearly everything sends — was downgraded to
	// octet-stream. Parameter values are also tighter here than they were: no whitespace inside one,
	// where the original accepted anything up to the next separator.
	if (contentType && /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+\s*=\s*[^;\s]+)*$/.test(contentType)) {
		return contentType
	}
	return 'application/octet-stream'
}
