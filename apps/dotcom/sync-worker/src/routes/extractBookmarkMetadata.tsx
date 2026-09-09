import { assert } from '@tldraw/utils'
import { getRateLimitKey, handleExtractBookmarkMetadataRequest } from '@tldraw/worker-shared'
import { IRequest } from 'itty-router'
import { Environment } from '../types'
import { isRateLimited } from '../utils/rateLimit'

export async function extractBookmarkMetadata(request: IRequest, env: Environment) {
	// Unfurling spends an outbound fetch per call on a URL the caller chose, so left unmetered this
	// is a way to have us make requests in volume to somewhere of their choosing. Anyone can paste a
	// link, including on an ownerless local board, so the budget is per address rather than per
	// account.
	if (await isRateLimited(env, getRateLimitKey(request as unknown as Request, 'unfurl'))) {
		return Response.json({ error: 'Too many requests' }, { status: 429 })
	}

	if (request.method === 'GET') {
		// legacy route: extract metadata without saving image
		return handleExtractBookmarkMetadataRequest({ request })
	}

	return handleExtractBookmarkMetadataRequest({
		request,
		uploadImage: async (headers, body, objectName) => {
			assert(env.ASSET_UPLOAD_ORIGIN, 'ASSET_UPLOAD_ORIGIN is required')
			assert(env.ASSET_UPLOAD_SECRET, 'ASSET_UPLOAD_SECRET is required')
			const url = `${env.ASSET_UPLOAD_ORIGIN}/uploads/${objectName}`

			// The asset upload worker's POST is on a public domain but is ours alone to call; this
			// is what tells it so. See `denyUnlessInternalCaller` there.
			const uploadHeaders = new Headers(headers)
			uploadHeaders.set('x-asset-upload-secret', env.ASSET_UPLOAD_SECRET)

			const response = await fetch(url, {
				method: 'POST',
				headers: uploadHeaders,
				body,
			})
			if (!response.ok) {
				throw new Error('Failed to upload image')
			}

			return url
		},
	})
}
