import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it } from 'vitest'
import { readConfig } from '../config'
import { AppContext } from '../http/context'
import { assetRoutes } from './routes'
import { AssetStore, MAX_ASSET_UPLOAD_BYTES } from './store'

/**
 * A stand-in for the S3 client, so these cover the rules the routes enforce — the size ceiling,
 * the name check, the conflict, the rate limit — without a bucket to run against. What it does not
 * cover is the S3 wire format itself; that needs a real MinIO or Garage.
 */
class FakeStore {
	objects = new Map<string, { body: Buffer; contentType: string }>()

	async exists(key: string) {
		return this.objects.has(key)
	}

	async get(key: string) {
		const object = this.objects.get(key)
		if (!object) return null
		return {
			body: Readable.from(object.body),
			contentType: object.contentType,
			contentLength: object.body.byteLength,
			etag: '"fake"',
			contentRange: undefined,
		}
	}

	async put(key: string, body: Buffer, contentType: string) {
		this.objects.set(key, { body, contentType })
	}
}

function makeContext(store: FakeStore | undefined): AppContext {
	return {
		config: readConfig({ DATABASE_PATH: ':memory:' } as NodeJS.ProcessEnv),
		directory: null as never,
		presence: null as never,
		assets: store as unknown as AssetStore | undefined,
	}
}

let store: FakeStore
let ctx: AppContext
/** Each test gets its own address so one test's uploads never spend another's budget. */
let nextIp = 0
let ip: string

beforeEach(() => {
	store = new FakeStore()
	ctx = makeContext(store)
	ip = `10.0.0.${nextIp++}`
})

function upload(name: string, body: BodyInit | null, headers: Record<string, string> = {}) {
	return assetRoutes.fetch(
		new Request(`https://example.com/uploads/${name}`, {
			method: 'POST',
			body,
			headers,
			...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
		} as RequestInit),
		ctx,
		ip
	)
}

describe('uploads', () => {
	it('stores a body and serves it back with its content type', async () => {
		expect((await upload('a.png', 'hello', { 'content-type': 'image/png' })).status).toBe(200)

		const response = await assetRoutes.fetch(
			new Request('https://example.com/uploads/a.png'),
			ctx,
			ip
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('image/png')
		expect(await response.text()).toBe('hello')
	})

	it('serves assets as immutable, sniff-proof and range-capable', async () => {
		await upload('a.mp3', 'x', { 'content-type': 'audio/mpeg' })
		const response = await assetRoutes.fetch(
			new Request('https://example.com/uploads/a.mp3'),
			ctx,
			ip
		)
		expect({
			cacheControl: response.headers.get('cache-control'),
			nosniff: response.headers.get('x-content-type-options'),
			ranges: response.headers.get('accept-ranges'),
		}).toEqual({
			cacheControl: 'public, max-age=31536000, immutable',
			nosniff: 'nosniff',
			ranges: 'bytes',
		})
	})

	it('refuses to overwrite an object that already exists', async () => {
		await upload('a.png', 'first', { 'content-type': 'image/png' })
		expect((await upload('a.png', 'second', { 'content-type': 'image/png' })).status).toBe(409)
		expect(store.objects.get('a.png')?.body.toString()).toBe('first')
	})

	it('keeps only a well-formed content type, so an uploader cannot choose response headers', async () => {
		await upload('a', 'x', { 'content-type': 'attachment; filename=evil.exe' })
		expect(store.objects.get('a')?.contentType).toBe('application/octet-stream')
	})

	it('keys an object on the raw path segment, so no encoding can walk out of the bucket', async () => {
		// Two things keep a traversal out, and neither is decoding: `new URL` resolves `..` and `.`
		// away before routing, and the router hands the segment over still encoded. So `%2F` names an
		// object whose key contains those three characters — not a path — and the GET that reads it
		// back spells it the same way. `isValidObjectName` covers the separators that survive as
		// literals (see store.test.ts).
		expect((await upload(encodeURIComponent('../secret'), 'x')).status).toBe(200)
		expect([...store.objects.keys()]).toEqual(['..%2Fsecret'])
	})

	it('refuses an oversized upload on its declared length, and stores nothing', async () => {
		const response = await upload('big', 'x', {
			'content-length': String(MAX_ASSET_UPLOAD_BYTES + 1),
		})
		expect({ status: response.status, stored: store.objects.size }).toEqual({
			status: 413,
			stored: 0,
		})
	})

	it('refuses a body that outruns a length it did not declare', async () => {
		const chunk = new Uint8Array(1024 * 1024)
		let sent = 0
		const body = new ReadableStream({
			pull(controller) {
				// Enough chunks to pass the cap, so the counter is what stops it rather than the header.
				if (sent++ > MAX_ASSET_UPLOAD_BYTES / chunk.byteLength) return controller.close()
				controller.enqueue(chunk)
			},
		})
		expect((await upload('big', body)).status).toBe(413)
	})

	it('answers 404 for an asset that is not there', async () => {
		const response = await assetRoutes.fetch(
			new Request('https://example.com/uploads/missing'),
			ctx,
			ip
		)
		expect(response.status).toBe(404)
	})

	it('answers 503 rather than failing obscurely when storage is unconfigured', async () => {
		ctx = makeContext(undefined)
		expect((await upload('a', 'x')).status).toBe(503)
		const get = await assetRoutes.fetch(new Request('https://example.com/uploads/a'), ctx, ip)
		expect(get.status).toBe(503)
	})

	it('meters uploads per caller', async () => {
		const statuses: number[] = []
		for (let i = 0; i < 32; i++) {
			statuses.push((await upload(`file-${i}`, 'x')).status)
		}
		// The burst is 30, so the tail is refused while the head went through.
		expect(statuses.filter((s) => s === 200).length).toBe(30)
		expect(statuses.at(-1)).toBe(429)
	})
})
