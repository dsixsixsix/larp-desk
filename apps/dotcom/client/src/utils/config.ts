import { isPreviewEnv, isProductionEnv, isStagingEnv } from './env'

export const BOOKMARK_ENDPOINT = '/api/unfurl'

if (!process.env.USER_CONTENT_URL) {
	throw new Error('Missing USER_CONTENT_URL env var')
}
export const USER_CONTENT_URL: string = process.env.USER_CONTENT_URL

if (!process.env.MULTIPLAYER_SERVER) {
	throw new Error('Missing MULTIPLAYER_SERVER env var')
}
if (!process.env.ZERO_SERVER) {
	throw new Error('Missing ZERO_SERVER env var')
}
export const MULTIPLAYER_SERVER =
	// if we're on the client in a production-ish environment, the origin should be on the same domain
	(isStagingEnv || isProductionEnv) && typeof location !== 'undefined'
		? `${window.location.origin}/api`
		: process.env.MULTIPLAYER_SERVER.replace(/^http/, 'ws')

/**
 * The same worker as `MULTIPLAYER_SERVER`, over http rather than ws. The presence socket needs the
 * ws form and the directory API needs fetch, and in staging and production both are the SPA's own
 * origin, so one is derived from the other rather than configured twice.
 */
export const API_SERVER: string = MULTIPLAYER_SERVER.replace(/^ws/, 'http')

export const ZERO_SERVER =
	(isStagingEnv || isProductionEnv || isPreviewEnv) && typeof location !== 'undefined'
		? process.env.ZERO_SERVER
		: 'http://localhost:4848/'

// Monotonic build identifier (epoch ms at build time, baked in by vite). Sent as `?v=` on sync
// websocket connections so the server can tell how stale a client bundle is. '0' outside a vite
// build (unit tests).
export const CLIENT_BUILD_TIMESTAMP: string = process.env.CLIENT_BUILD_TIMESTAMP ?? '0'
