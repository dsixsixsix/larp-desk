/**
 * The per-caller guard on the asset upload endpoints.
 *
 * Uploads are the one write anonymous callers can make — a local board has no owner, so there is no
 * account to attribute an upload to and nothing to gate it on. That leaves the caller's address as
 * the only thing to count, which is why this is a ceiling on abuse rather than a real
 * authorization check: it bounds what one source can spend of our storage without stopping anyone
 * who can spread the same requests across addresses.
 */

/** The `ratelimit` binding's surface, narrowed to what these workers use. */
export interface RateLimiterBinding {
	limit(options: { key: string }): Promise<{ success: boolean }>
}

/**
 * The address a rate limit budget belongs to. `cf-connecting-ip` is set by the edge and cannot be
 * spoofed by the client; without it — only possible off Cloudflare, i.e. in tests and local dev —
 * every caller shares one budget, which fails towards limiting rather than towards letting through.
 */
export function getRateLimitKey(request: Request, prefix: string): string {
	return `${prefix}:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`
}

/**
 * A 429 for a caller that has spent its budget, or `undefined` to continue.
 *
 * A missing binding is not treated as a pass: a worker that reaches this without one is
 * misconfigured, and an upload endpoint running unmetered is the thing this exists to prevent.
 */
export async function checkUploadRateLimit(
	limiter: RateLimiterBinding | undefined,
	request: Request,
	prefix: string
): Promise<Response | undefined> {
	if (!limiter) {
		console.error('Upload rate limiter binding is missing; refusing the upload')
		return tooManyRequests()
	}
	const { success } = await limiter.limit({ key: getRateLimitKey(request, prefix) })
	return success ? undefined : tooManyRequests()
}

function tooManyRequests() {
	return Response.json({ error: 'Too many requests' }, { status: 429 })
}
