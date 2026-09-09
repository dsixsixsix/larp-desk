import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	MAX_ASSET_UPLOAD_BYTES,
	MAX_R2_OBJECT_NAME_BYTES,
	handleUserAssetGet,
	handleUserAssetUpload,
} from './userAssetUploads'

describe('userAssetUploads', () => {
	const match = vi.fn()
	const putCache = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		match.mockResolvedValue(undefined)
		putCache.mockResolvedValue(undefined)
		vi.stubGlobal('caches', {
			default: {
				match,
				put: putCache,
			},
		})
	})

	describe('handleUserAssetGet', () => {
		it('returns 400 without calling R2 when the object name is too long', async () => {
			const bucket = {
				head: vi.fn(),
				get: vi.fn(),
				put: vi.fn(),
			}
			const response = await handleUserAssetGet({
				request: new Request('https://example.com/assets/too-long') as any,
				bucket,
				objectName: 'a'.repeat(MAX_R2_OBJECT_NAME_BYTES + 1),
				context: { waitUntil: vi.fn() } as any,
			})

			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: 'Invalid object name' })
			expect(bucket.get).not.toHaveBeenCalled()
			expect(match).not.toHaveBeenCalled()
		})

		it('returns 400 when R2 rejects a valid-looking object name as invalid', async () => {
			const bucket = {
				head: vi.fn(),
				get: vi
					.fn()
					.mockRejectedValue(new Error('get: The specified object name is not valid. (10020)')),
				put: vi.fn(),
			}
			const response = await handleUserAssetGet({
				request: new Request('https://example.com/assets/test') as any,
				bucket,
				objectName: 'test',
				context: { waitUntil: vi.fn() } as any,
			})

			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: 'Invalid object name' })
			expect(bucket.get).toHaveBeenCalledTimes(1)
		})
	})

	describe('handleUserAssetUpload', () => {
		it('returns 400 without calling R2 when the object name is too long', async () => {
			const bucket = {
				head: vi.fn(),
				get: vi.fn(),
				put: vi.fn(),
			}
			const response = await handleUserAssetUpload({
				body: null,
				headers: new Headers(),
				bucket,
				objectName: 'a'.repeat(MAX_R2_OBJECT_NAME_BYTES + 1),
			})

			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: 'Invalid object name' })
			expect(bucket.head).not.toHaveBeenCalled()
			expect(bucket.put).not.toHaveBeenCalled()
		})

		it('returns 400 when R2 rejects a valid-looking object name as invalid', async () => {
			const bucket = {
				head: vi
					.fn()
					.mockRejectedValue(new Error('get: The specified object name is not valid. (10020)')),
				get: vi.fn(),
				put: vi.fn(),
			}
			const response = await handleUserAssetUpload({
				body: null,
				headers: new Headers(),
				bucket,
				objectName: 'test',
			})

			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: 'Invalid object name' })
			expect(bucket.head).toHaveBeenCalledTimes(1)
			expect(bucket.put).not.toHaveBeenCalled()
		})

		it('returns 413 from the content-length alone, without reading the body or calling R2', async () => {
			const bucket = { head: vi.fn(), get: vi.fn(), put: vi.fn() }
			const response = await handleUserAssetUpload({
				body: streamOf(1),
				headers: new Headers({ 'content-length': String(MAX_ASSET_UPLOAD_BYTES + 1) }),
				bucket,
				objectName: 'test',
			})

			expect(response.status).toBe(413)
			expect(await response.json()).toEqual({
				error: 'Asset is too large',
				maxBytes: MAX_ASSET_UPLOAD_BYTES,
			})
			expect(bucket.head).not.toHaveBeenCalled()
			expect(bucket.put).not.toHaveBeenCalled()
		})

		it('returns 413 when a body outruns the cap despite a content-length that says otherwise', async () => {
			const bucket = {
				head: vi.fn().mockResolvedValue(null),
				get: vi.fn(),
				// R2 only fails once it drains the stream, which is when the limiter errors it.
				put: vi.fn(async (_key: string, value: ReadableStream) => {
					await new Response(value as any).arrayBuffer()
					return { httpEtag: 'etag' }
				}),
			}
			const response = await handleUserAssetUpload({
				body: streamOf(MAX_ASSET_UPLOAD_BYTES + 1),
				headers: new Headers({ 'content-length': '10' }),
				bucket,
				objectName: 'test',
			})

			expect(response.status).toBe(413)
			expect(bucket.put).toHaveBeenCalledTimes(1)
		})

		it('streams the body rather than buffering it, and stores only a validated content type', async () => {
			let stored: unknown
			const bucket = {
				head: vi.fn().mockResolvedValue(null),
				get: vi.fn(),
				put: vi.fn(async (_key: string, value: unknown, options: any) => {
					stored = options.httpMetadata
					return { httpEtag: 'etag' }
				}),
			}
			const response = await handleUserAssetUpload({
				body: streamOf(64),
				headers: new Headers({
					'content-type': 'image/png',
					'content-disposition': 'attachment; filename="invoice.pdf"',
				}),
				bucket,
				objectName: 'test',
			})

			expect(response.status).toBe(200)
			expect(stored).toEqual({ contentType: 'image/png' })
			expect(bucket.put.mock.calls[0][1]).toBeInstanceOf(ReadableStream)
		})

		it('falls back to an inert content type when the uploader supplies a malformed one', async () => {
			let stored: any
			const bucket = {
				head: vi.fn().mockResolvedValue(null),
				get: vi.fn(),
				put: vi.fn(async (_key: string, _value: unknown, options: any) => {
					stored = options.httpMetadata
					return { httpEtag: 'etag' }
				}),
			}
			await handleUserAssetUpload({
				body: streamOf(8),
				headers: new Headers({ 'content-type': 'image/png, text/html; charset="a"b' }),
				bucket,
				objectName: 'test',
			})

			expect(stored).toEqual({ contentType: 'application/octet-stream' })
		})
	})
})

/** A body of exactly `bytes`, delivered in chunks so the limiter has to count across them. */
function streamOf(bytes: number): ReadableStream {
	const CHUNK = 64 * 1024
	let sent = 0
	return new ReadableStream({
		pull(controller) {
			if (sent >= bytes) {
				controller.close()
				return
			}
			const size = Math.min(CHUNK, bytes - sent)
			sent += size
			controller.enqueue(new Uint8Array(size))
		},
	})
}
