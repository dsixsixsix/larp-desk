import { IRequest, Router } from 'itty-router'
import { assetRoutes } from '../assets/routes'
import { unoDirectoryRoutes } from '../directory/routes'
import { unfurlRoutes } from '../unfurl/routes'
import { AppContext } from './context'
import { blockUnknownOrigins, corsify, preflight } from './cors'

/**
 * The whole HTTP surface.
 *
 * Note what is *not* here, compared with the Cloudflare worker this replaced: no `/app/*` document
 * routes, no published snapshots, no OG images, no MCP server, no zero mutate/query. Those served
 * the full shape, which needs Postgres and an identity provider; the standalone shape is the
 * directory, presence, assets and link previews, and this is all of it.
 */
export const router = Router<IRequest, [AppContext, string]>()

router
	.all('*', (request, ctx) => preflight(request as unknown as Request, ctx.config))
	.all('*', (request, ctx) => blockUnknownOrigins(request as unknown as Request, ctx.config))
	// Liveness only: it must not touch the database or storage, so a check that fails means the
	// process is gone rather than that a dependency is slow.
	.get('/health', (_request, ctx) => Response.json({ ok: true, presence: ctx.presence.stats() }))
	.all('*', unoDirectoryRoutes.fetch)
	.all('*', assetRoutes.fetch)
	.all('*', unfurlRoutes.fetch)
	.all('*', () => Response.json({ error: 'Not found' }, { status: 404 }))

/**
 * Runs a request through the router and stamps the CORS headers on whatever comes back.
 *
 * An unhandled error becomes a 500 with nothing in the body: the message could name a bucket, a
 * path or a query, and the caller has no use for any of it. The log line keeps the detail.
 */
export async function handleRequest(
	request: Request,
	ctx: AppContext,
	callerIp: string
): Promise<Response> {
	try {
		const response = await router.fetch(request, ctx, callerIp)
		return corsify(response, request, ctx.config)
	} catch (error) {
		console.error('[request]', request.method, new URL(request.url).pathname, error)
		return corsify(Response.json({ error: 'Internal error' }, { status: 500 }), request, ctx.config)
	}
}
