import { ServerConfig } from '../config'

/**
 * Which cross-origin callers this deployment answers.
 *
 * The Cloudflare version hardcoded tldraw's own domains, which is exactly the thing a fork cannot
 * use. Here the list is configuration, and an empty list is the right default rather than a broken
 * one: the ordinary deployment serves the SPA and this server from one origin, so every call is
 * same-origin and never consults it.
 *
 * A `*.example.com` entry matches any subdomain and the bare domain; anything else must match
 * exactly. No entry ever matches by suffix alone — `evil-example.com` must not pass for
 * `example.com`.
 */
export function isAllowedOrigin(origin: string, allowed: string[]): boolean {
	if (!origin) return false
	for (const entry of allowed) {
		if (entry === '*') return true
		if (entry === origin) return true
		if (entry.startsWith('*.')) {
			const domain = entry.slice(2)
			if (origin === `https://${domain}` || origin === `http://${domain}`) return true
			if (origin.endsWith(`.${domain}`)) return true
		}
	}
	return false
}

const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS'
const ALLOWED_HEADERS = 'authorization, content-type'

/**
 * Refuses a cross-origin request from an origin that was not configured.
 *
 * Same-origin requests are let through without consulting the list — `sec-fetch-site` is set by the
 * browser and cannot be forged by page script — and a request with no `origin` at all is not a
 * cross-origin one either.
 */
export function blockUnknownOrigins(request: Request, config: ServerConfig): Response | undefined {
	if (request.headers.get('sec-fetch-site') === 'same-origin') return undefined
	const origin = request.headers.get('origin')
	if (!origin) return undefined
	if (isAllowedOrigin(origin, config.allowedOrigins)) return undefined
	return new Response('Not allowed', { status: 403 })
}

/** Answers a preflight, so the browser never dispatches the real request into a handler. */
export function preflight(request: Request, config: ServerConfig): Response | undefined {
	if (request.method !== 'OPTIONS') return undefined
	const origin = request.headers.get('origin')
	if (!origin || !isAllowedOrigin(origin, config.allowedOrigins)) {
		return new Response(null, { status: 204 })
	}
	return new Response(null, {
		status: 204,
		headers: {
			'access-control-allow-origin': origin,
			'access-control-allow-methods': ALLOWED_METHODS,
			'access-control-allow-headers': ALLOWED_HEADERS,
			'access-control-max-age': '86400',
			vary: 'origin',
		},
	})
}

/** Stamps the allow-origin headers on a response that is going somewhere cross-origin. */
export function corsify(response: Response, request: Request, config: ServerConfig): Response {
	const origin = request.headers.get('origin')
	if (!origin || !isAllowedOrigin(origin, config.allowedOrigins)) return response
	// Cloned rather than mutated: a Response built from a stream has immutable headers until it is
	// reconstructed, and the asset routes return exactly that.
	const headers = new Headers(response.headers)
	headers.set('access-control-allow-origin', origin)
	headers.append('vary', 'origin')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
