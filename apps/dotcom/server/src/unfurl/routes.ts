import { IRequest, Router } from 'itty-router'
import { AppContext } from '../http/context'
import { RateLimiter } from '../http/rateLimit'
import { assertPublicHttpUrl } from './publicUrl'
import { unfurl } from './unfurl'

/**
 * Link previews for the bookmark shape. The client reaches this at `/unfurl` (see
 * `BOOKMARK_ENDPOINT` in the client's config).
 *
 * Cloudflare's version had a second job: it also downloaded the page's own preview image, resized
 * it through Cloudflare's image transformations, and stored it. That is gone. The metadata carries
 * the image's original URL and the browser fetches it directly, which costs a hotlink and saves the
 * whole resizing pipeline — worth it for a self-hosted deployment, where that pipeline would be
 * another service to run.
 */
export const unfurlRoutes = Router<IRequest, [AppContext, string]>()

/**
 * Unfurling spends an outbound fetch per call on a URL the caller chose, so left unmetered this is
 * a way to have this server make requests in volume to somewhere of their choosing. Anyone can
 * paste a link, including on an ownerless local board, so the budget is per address rather than per
 * account.
 */
const unfurls = new RateLimiter(20, 1)

async function handle(request: IRequest, _ctx: AppContext, callerIp: string) {
	if (!unfurls.check(callerIp)) {
		return Response.json({ error: 'Too many requests' }, { status: 429 })
	}

	const raw = new URL(request.url).searchParams.get('url')
	if (!raw) return Response.json({ error: 'Bad URL' }, { status: 400 })

	// The caller picks this URL and we fetch it, which makes this endpoint a way to reach anything
	// this server can reach.
	if (!(await assertPublicHttpUrl(raw))) {
		return Response.json({ error: 'Bad URL' }, { status: 400 })
	}

	const result = await unfurl(raw)
	if (!result.ok) {
		return result.error === 'bad-param'
			? Response.json({ error: 'Bad URL' }, { status: 400 })
			: Response.json({ error: 'Failed to fetch URL' }, { status: 422 })
	}
	return Response.json(result.value)
}

// Both methods, because the client used POST against Cloudflare's image-storing variant and GET
// against the plain one. They do the same thing here.
unfurlRoutes.get('/unfurl', handle).post('/unfurl', handle)
