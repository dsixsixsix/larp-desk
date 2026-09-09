import { R2Bucket, WorkerVersionMetadata } from '@cloudflare/workers-types'
import { RateLimiterBinding } from '@tldraw/worker-shared'

export interface Environment {
	// bindings
	UPLOADS: R2Bucket
	CF_VERSION_METADATA: WorkerVersionMetadata
	UPLOAD_RATE_LIMITER: RateLimiterBinding

	// environment variables
	TLDRAW_ENV: string | undefined
	SENTRY_DSN: string | undefined
	IS_LOCAL: string | undefined
	WORKER_NAME: string | undefined
	/** Shared with the sync worker, the only caller allowed to POST here. Set as a wrangler secret. */
	ASSET_UPLOAD_SECRET: string | undefined
}
