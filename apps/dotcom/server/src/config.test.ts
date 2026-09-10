import { describe, expect, it } from 'vitest'
import { readConfig } from './config'

describe('allowed origins', () => {
	it('lets the client dev server through outside production', () => {
		// The client's dev server is a different origin from this one, so every call it makes is
		// cross-origin. Without this the whole app fails at the first request with a CORS error and
		// nothing on the server side to show for it.
		expect(readConfig({} as NodeJS.ProcessEnv).allowedOrigins).toContain('http://localhost:3000')
	})

	it('allows nothing by default in production', () => {
		// A deployment serves the SPA from this server's own origin, so nothing legitimate is
		// cross-origin there, and a standing localhost allowance would let any page a developer
		// happens to be running talk to a production API from their browser.
		expect(readConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).allowedOrigins).toEqual([])
	})

	it('takes the configured list over either default', () => {
		for (const NODE_ENV of ['production', 'development']) {
			expect(
				readConfig({
					NODE_ENV,
					ALLOWED_ORIGINS: 'https://a.example, https://b.example',
				} as NodeJS.ProcessEnv).allowedOrigins
			).toEqual(['https://a.example', 'https://b.example'])
		}
	})
})

describe('S3 configuration', () => {
	it('is absent when nothing is set, so uploads fail with a stated reason', () => {
		expect(readConfig({} as NodeJS.ProcessEnv).s3).toBeUndefined()
	})

	it('refuses to start on a half-configured store', () => {
		// Half a configuration would start, serve boards, and fail only when someone dropped an image
		// on one.
		expect(() =>
			readConfig({ S3_ENDPOINT: 'http://storage:9000', S3_BUCKET: 'uploads' } as NodeJS.ProcessEnv)
		).toThrow(/S3_ACCESS_KEY_ID/)
	})
})
