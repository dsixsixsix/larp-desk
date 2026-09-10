/**
 * Everything the server reads from its environment, parsed and checked once at boot.
 *
 * A misconfigured deployment should fail here, loudly, rather than at the first request that
 * needs the missing value — the Cloudflare version got that for free from wrangler's typed
 * bindings, and this is what stands in for them.
 */

/** Splits a comma or whitespace separated list from an environment variable. */
export function parseList(raw: string | undefined): string[] {
	if (!raw) return []
	return raw
		.split(/[\s,]+/)
		.map((value) => value.trim())
		.filter(Boolean)
}

function parsePort(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback
	const value = Number(raw)
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`PORT must be a port number, got ${JSON.stringify(raw)}`)
	}
	return value
}

export interface S3Config {
	endpoint: string
	region: string
	bucket: string
	accessKeyId: string
	secretAccessKey: string
	/** MinIO and Garage address buckets by path; AWS by subdomain. */
	forcePathStyle: boolean
}

export interface ServerConfig {
	host: string
	port: number

	/** Admits the one administrator account. Unset means nobody can sign in as admin. */
	adminSecret: string | undefined

	/** Where the directory's SQLite file lives. Must be on a volume that survives a restart. */
	databasePath: string

	/**
	 * Origins allowed to call this server cross-origin. Same-origin requests never consult it, so
	 * the ordinary deployment — SPA and API behind one domain — needs nothing here.
	 */
	allowedOrigins: string[]

	/** See iceServers.ts. Without turnUrls voice is STUN-only and silent behind symmetric NAT. */
	turnUrls: string | undefined
	turnAuth: string | undefined
	stunUrls: string | undefined

	/** Absent means assets are refused rather than silently dropped. */
	s3: S3Config | undefined

	/**
	 * Whether to believe `x-forwarded-for`. True behind the reverse proxy this is deployed with,
	 * and false anywhere the header could be set by the caller — it keys the upload rate limit.
	 */
	trustProxy: boolean
}

function readS3(env: NodeJS.ProcessEnv): S3Config | undefined {
	const endpoint = env.S3_ENDPOINT
	const bucket = env.S3_BUCKET
	const accessKeyId = env.S3_ACCESS_KEY_ID
	const secretAccessKey = env.S3_SECRET_ACCESS_KEY
	if (!endpoint && !bucket && !accessKeyId && !secretAccessKey) return undefined

	const missing = [
		['S3_ENDPOINT', endpoint],
		['S3_BUCKET', bucket],
		['S3_ACCESS_KEY_ID', accessKeyId],
		['S3_SECRET_ACCESS_KEY', secretAccessKey],
	]
		.filter(([, value]) => !value)
		.map(([name]) => name)

	// Half a configuration is worse than none: it would start, serve boards, and fail only when
	// someone dropped an image on one.
	if (missing.length > 0) {
		throw new Error(`S3 storage is partly configured; missing ${missing.join(', ')}`)
	}

	return {
		endpoint: endpoint!,
		region: env.S3_REGION ?? 'us-east-1',
		bucket: bucket!,
		accessKeyId: accessKeyId!,
		secretAccessKey: secretAccessKey!,
		forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
	}
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	return {
		host: env.HOST ?? '0.0.0.0',
		port: parsePort(env.PORT, 8787),
		adminSecret: env.UNO_ADMIN_SECRET || undefined,
		databasePath: env.DATABASE_PATH ?? '/data/directory.sqlite',
		allowedOrigins: parseList(env.ALLOWED_ORIGINS),
		turnUrls: env.TURN_URLS || undefined,
		turnAuth: env.TURN_AUTH || undefined,
		stunUrls: env.STUN_URLS || undefined,
		s3: readS3(env),
		trustProxy: env.TRUST_PROXY === 'true',
	}
}

/**
 * Warnings worth printing at boot for a deployment that will start but not work properly.
 *
 * Each of these fails silently at runtime — no admin can sign in, voice is quiet for some people,
 * images vanish on drop — so the only place they are cheap to notice is here.
 */
export function configWarnings(config: ServerConfig): string[] {
	const warnings: string[] = []
	if (!config.adminSecret) {
		warnings.push(
			'UNO_ADMIN_SECRET is unset: nobody can sign in as admin, so nobody can be invited.'
		)
	}
	if (!config.turnUrls || !config.turnAuth) {
		warnings.push(
			'TURN_URLS/TURN_AUTH are unset: voice falls back to STUN only, which is silence behind symmetric NAT, a UDP-blocking firewall, or a VPN.'
		)
	}
	if (!config.s3) {
		warnings.push('S3 storage is unconfigured: images, audio and video cannot be added to boards.')
	}
	return warnings
}
