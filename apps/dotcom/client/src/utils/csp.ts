export const cspDirectives: { [key: string]: string[] } = {
	'default-src': [`'self'`],
	'connect-src': [
		`'self'`,
		`ws:`,
		`wss:`,
		'blob:',
		'data:',
		// The sync worker in local dev. In staging and production it is the app's own origin, so
		// `'self'` covers it there and only the dev port needs naming (see utils/config.ts).
		'http://localhost:8787',
		'http://localhost:8788',
		'http://localhost:8789',
		`https://*.tldraw.xyz`,
		`https://cdn.tldraw.com`,
		`https://*.tldraw.workers.dev`,
		`https://*.ingest.sentry.io`,
		`https://*.ingest.us.sentry.io`,
		'https://*.analytics.google.com',
		'https://analytics.google.com',
		'https://www.google-analytics.com',
		'https://*.googletagmanager.com',
		'https://www.googletagmanager.com',
		// for thumbnail server
		'http://localhost:5002',
		'https://*.clerk.accounts.dev',
		'https://clerk.tldraw.com',
		'https://clerk.staging.tldraw.com',
		'https://clerk-telemetry.com',
		// zero
		'https://*.zero.tldraw.com',
		'https://zero.tldraw.com',
		'http://localhost:4848',
		'https://analytics.tldraw.com',
		'https://consent.tldraw.xyz',
		'https://stats.g.doubleclick.net',
		'https://*.google-analytics.com',
		'https://api.reo.dev',
		'https://fonts.googleapis.com',
		// asset uploads/serving
		'https://tldrawusercontent.com',
		'https://*.tldrawusercontent.com',
	],
	'font-src': [`'self'`, `https://fonts.googleapis.com`, `https://fonts.gstatic.com`, 'data:'],
	'frame-src': [`'self'`, `https:`],
	'img-src': [`'self'`, `http:`, `https:`, `data:`, `blob:`],
	'media-src': [`'self'`, `http:`, `https:`, `data:`, `blob:`],
	'script-src': [
		`'self'`,
		'https://challenges.cloudflare.com',
		'https://*.clerk.accounts.dev',
		'https://clerk.tldraw.com',
		'https://clerk.staging.tldraw.com',
		// embeds that have scripts
		'https://gist.github.com',
		'https://www.googletagmanager.com',
		'https://*.googletagmanager.com',
		'https://www.google-analytics.com',
		'https://*.google-analytics.com',
		'https://analytics.tldraw.com',
		'https://static.reo.dev',
	],
	'worker-src': [`'self'`, `blob:`],
	'style-src': [`'self'`, `'unsafe-inline'`, `https://fonts.googleapis.com`],
	'style-src-elem': [
		`'self'`,
		`'unsafe-inline'`,
		`https://fonts.googleapis.com`,
		// embeds that have styles
		'https://github.githubassets.com',
	],
	'report-uri': [process.env.SENTRY_CSP_REPORT_URI ?? ``],
}

/**
 * The origins a self-hosted deployment serves its own backend from.
 *
 * Same-origin is the ordinary arrangement and `'self'` already covers it. This is for the
 * deployment that splits them — object storage on its own domain, say — where the upload `fetch`
 * is cross-origin and would otherwise be refused by `connect-src` with nothing in the network tab
 * to explain it.
 */
function configuredBackendOrigins(): string[] {
	const origins = new Set<string>()
	for (const value of [process.env.MULTIPLAYER_SERVER, process.env.USER_CONTENT_URL]) {
		if (!value) continue
		try {
			origins.add(new URL(value).origin)
		} catch {
			// Not a URL we can read an origin from. The build validates these separately; a bad value
			// is not this function's to report.
		}
	}
	return [...origins]
}

for (const directive of ['connect-src', 'img-src', 'media-src'] as const) {
	for (const origin of configuredBackendOrigins()) {
		if (!cspDirectives[directive].includes(origin)) cspDirectives[directive].push(origin)
	}
}

export const csp = Object.keys(cspDirectives)
	// An empty directive is not merely useless: `report-uri` with no value is a parse error for the
	// whole policy in some browsers, and it is empty whenever no Sentry report URI is configured.
	.filter((directive) => cspDirectives[directive].some((value) => value !== ''))
	.map((directive) => `${directive} ${cspDirectives[directive].filter(Boolean).join(' ')}`)
	.join('; ')

export const cspDev = Object.keys(cspDirectives)
	.filter((key) => key !== 'report-uri')
	.map((directive) => {
		const values = cspDirectives[directive]
		// We allow data: urls for frame-src to allow debugging SVG embeds in dev.
		if (directive === 'frame-src') return `${directive} ${[...values, 'data:'].join(' ')}`
		return `${directive} ${values.join(' ')}`
	})
	.join('; ')
