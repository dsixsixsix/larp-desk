/// <reference no-default-lib="true"/>
/// <reference types="@cloudflare/workers-types" />

import {
	blockUnknownOrigins,
	checkUploadRateLimit,
	createRouter,
	forbidden,
	handleApiRequest,
	handleUserAssetGet,
	handleUserAssetUpload,
	isAllowedOrigin,
	notFound,
} from '@tldraw/worker-shared'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { cors } from 'itty-router'
import { Environment } from './types'

const { preflight, corsify } = cors({ origin: isAllowedOrigin })

export default class Worker extends WorkerEntrypoint<Environment> {
	readonly router = createRouter<Environment>()
		.all('*', preflight)
		.all('*', blockUnknownOrigins)
		.get('/uploads/:objectName', async (request) => {
			return handleUserAssetGet({
				request,
				bucket: this.env.UPLOADS,
				objectName: request.params.objectName,
				context: this.ctx,
			})
		})
		.post('/uploads/:objectName', async (request) => {
			const denied = this.denyUnlessInternalCaller(request)
			if (denied) return denied

			const limited = await checkUploadRateLimit(
				this.env.UPLOAD_RATE_LIMITER,
				request,
				'legacy-upload'
			)
			if (limited) return limited

			return handleUserAssetUpload({
				headers: request.headers,
				body: request.body,
				bucket: this.env.UPLOADS,
				objectName: request.params.objectName,
			})
		})
		.all('*', notFound)

	/**
	 * This bucket's only writer is the sync worker's bookmark unfurler, which posts the preview
	 * image it fetched. The route is on a public custom domain though, and read access is the only
	 * thing the outside world needs from it — left open, POST is an anonymous write into production
	 * storage, which is free hosting for whatever anyone cares to put there.
	 *
	 * A shared secret rather than an origin check, because `blockUnknownOrigins` lets a request
	 * with no `Origin` header through — every non-browser caller, which is exactly this one — and so
	 * cannot tell our unfurler from curl.
	 *
	 * Fails closed when `ASSET_UPLOAD_SECRET` is unset, which is what makes it worth having: a
	 * deployment that forgets the secret loses bookmark preview images and keeps a closed bucket,
	 * rather than silently keeping an open one. Local dev is exempt so it needs no setup.
	 */
	private denyUnlessInternalCaller(request: Request): Response | undefined {
		if (this.env.IS_LOCAL === 'true') return undefined
		const expected = this.env.ASSET_UPLOAD_SECRET
		if (!expected) {
			console.error('ASSET_UPLOAD_SECRET is not configured; refusing the upload')
			return forbidden()
		}
		const presented = request.headers.get('x-asset-upload-secret')
		if (!presented || !timingSafeEqual(presented, expected)) return forbidden()
		return undefined
	}

	override async fetch(request: Request) {
		return handleApiRequest({
			router: this.router,
			request,
			env: this.env,
			ctx: this.ctx,
			after: corsify,
		})
	}
}

/**
 * Compares without leaking, through how long it took, how much of the secret a guess got right.
 * Length is not secret — it is fixed by our own configuration — so returning early on it is fine.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return diff === 0
}
