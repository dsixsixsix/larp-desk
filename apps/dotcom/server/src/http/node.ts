import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * The bridge between Node's HTTP server and the WHATWG `Request`/`Response` the route handlers are
 * written against.
 *
 * The routes came off Cloudflare unchanged because of this file: `itty-router` is runtime-agnostic
 * and Node has had `Request`, `Response`, `Headers` and `fetch` as globals since 18, so the only
 * thing missing was the conversion at each end.
 */

/**
 * The request's origin as the caller reached it, which is not always what the socket says.
 *
 * Behind the reverse proxy this is deployed with, the TLS termination and the public hostname are
 * the proxy's, so `x-forwarded-*` is the only record of them. Believed only when the deployment
 * says it is behind a proxy — otherwise a caller could set the headers itself, and the URL these
 * build is what route matching and the session's own origin checks run on.
 */
function originOf(req: IncomingMessage, trustProxy: boolean): string {
	const forwardedHost = trustProxy ? firstValue(req.headers['x-forwarded-host']) : undefined
	const forwardedProto = trustProxy ? firstValue(req.headers['x-forwarded-proto']) : undefined
	const host = forwardedHost ?? firstValue(req.headers.host) ?? 'localhost'
	const protocol =
		forwardedProto ?? ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http')
	return `${protocol}://${host}`
}

function firstValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0]
	if (!value) return undefined
	// A comma-separated forwarded header lists every hop; the first entry is the original caller.
	return value.split(',')[0]?.trim() || undefined
}

/**
 * The caller's IP, for the upload rate limit.
 *
 * Behind a proxy every connection appears to come from the proxy, so without the forwarded header
 * one budget would be shared by everybody. Trusting the header when there is no proxy is the
 * opposite failure — anyone could pick their own bucket — which is why this follows `trustProxy`.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
	if (trustProxy) {
		const forwarded = firstValue(req.headers['x-forwarded-for'])
		if (forwarded) return forwarded
	}
	return req.socket.remoteAddress ?? 'unknown'
}

export function toRequest(req: IncomingMessage, trustProxy: boolean): Request {
	const url = new URL(req.url ?? '/', originOf(req, trustProxy))
	const headers = new Headers()
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) for (const item of value) headers.append(name, item)
		else headers.set(name, value)
	}

	const method = req.method ?? 'GET'
	const hasBody = method !== 'GET' && method !== 'HEAD'
	return new Request(url, {
		method,
		headers,
		// Streamed rather than buffered so an upload never sits in memory in full. `duplex` is
		// required by the spec whenever the body is a stream.
		body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
		...(hasBody ? { duplex: 'half' } : {}),
	} as RequestInit)
}

export async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
	const headers: Record<string, string | string[]> = {}
	for (const [name, value] of response.headers) {
		// `set-cookie` is the one header that may legitimately repeat, and joining it with commas
		// merges cookies into one malformed value.
		if (name.toLowerCase() === 'set-cookie') {
			headers[name] = response.headers.getSetCookie?.() ?? [value]
		} else {
			headers[name] = value
		}
	}
	res.writeHead(response.status, headers)

	if (!response.body) {
		res.end()
		return
	}

	try {
		await pipeline(Readable.fromWeb(response.body as never), res)
	} catch {
		// The client hung up mid-stream, or the upstream body failed. The socket is already going;
		// destroying it is all that is left, and swallowing this is what keeps one aborted download
		// from becoming an unhandled rejection.
		res.destroy()
	}
}
