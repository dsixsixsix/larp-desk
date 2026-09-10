/**
 * Link previews for the bookmark shape.
 *
 * A reimplementation of `cloudflare-workers-unfurl`, which drives Cloudflare's `HTMLRewriter` and
 * so cannot run here. The extraction rules are kept identical — same tag precedence, same relative
 * URL resolution, same result shape — because the client renders whatever comes back and a
 * different shape would show up as a blank bookmark rather than an error.
 */

export interface UnfurledData {
	title?: string
	description?: string
	image?: string
	favicon?: string
	imageWidth?: number
	imageHeight?: number
}

export type UnfurlError = 'bad-param' | 'failed-fetch'

export type UnfurlResult = { ok: true; value: UnfurledData } | { ok: false; error: UnfurlError }

const VALID_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'application/xml', 'image/*']

/**
 * How much of the page to read.
 *
 * Everything extracted lives in `<head>`, and the caller picked this URL — so without a cap, a
 * response that never ends is a way to hold a connection and a buffer here for as long as it likes.
 */
const MAX_HTML_BYTES = 512 * 1024

/** How long to wait on the page. Long enough for a slow site, short enough to not pile up. */
const FETCH_TIMEOUT_MS = 10_000

const USER_AGENT = 'unocode-bot/1.0'

function isValidContentType(contentType: string): boolean {
	return (
		// allow unspecified, try to parse it anyway
		!contentType ||
		contentType.startsWith('image/') ||
		VALID_CONTENT_TYPES.some((valid) => contentType.startsWith(valid))
	)
}

export async function unfurl(url: string): Promise<UnfurlResult> {
	if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
		return { ok: false, error: 'bad-param' }
	}

	let html: string
	try {
		const headers = new Headers()
		for (const contentType of VALID_CONTENT_TYPES) headers.append('accept', contentType)
		// Some sites block requests that don't have a user agent.
		headers.set('user-agent', USER_AGENT)

		const response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			// A redirect is followed to somewhere the caller did not name and this server did not
			// check, which is the private-address gate reopened one hop later.
			redirect: 'manual',
		})

		if (response.status >= 300 && response.status < 400) {
			return { ok: false, error: 'failed-fetch' }
		}

		const contentType = response.headers.get('content-type') ?? ''
		if (!response.ok || !isValidContentType(contentType)) {
			return { ok: false, error: 'failed-fetch' }
		}

		if (contentType.startsWith('image/')) {
			return {
				ok: true,
				value: { image: url, title: new URL(url).pathname.split('/').pop() || undefined },
			}
		}

		html = await readCapped(response, MAX_HTML_BYTES)
	} catch {
		return { ok: false, error: 'failed-fetch' }
	}

	return { ok: true, value: extractMetadata(html, url) }
}

/** Reads at most `maxBytes` of the body, then stops — the rest of the page is not needed. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return ''
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let seen = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done || !value) break
			chunks.push(value)
			seen += value.byteLength
			if (seen >= maxBytes) break
		}
	} finally {
		await reader.cancel().catch(() => undefined)
	}
	return Buffer.concat(chunks.map((c) => Buffer.from(c)))
		.subarray(0, maxBytes)
		.toString('utf8')
}

/**
 * The document's `<head>`, or the whole string when there is no closing tag.
 *
 * Every tag read below is a head tag, and stopping there keeps a `<meta>` inside body content —
 * a comment, a code sample, a user-authored post — from being read as the page's own metadata.
 */
function headOf(html: string): string {
	const end = html.search(/<\/head\s*>/i)
	return end === -1 ? html : html.slice(0, end)
}

const TAG_PATTERN = /<(meta|link|title)\b([^>]*)>([\s\S]*?)(?=<)/gi
const ATTRIBUTE_PATTERN = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g

function attributesOf(raw: string): Record<string, string> {
	const attributes: Record<string, string> = {}
	for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
		attributes[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '')
	}
	return attributes
}

/**
 * The five entities that must be escaped in an attribute value, plus numeric references.
 *
 * A full entity table is not worth carrying for metadata that is displayed as text: anything left
 * undecoded shows as the literal `&copy;`, which is a cosmetic flaw in a bookmark title.
 */
function decodeEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&')
}

function safeCodePoint(code: number): string {
	if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
	try {
		return String.fromCodePoint(code)
	} catch {
		return ''
	}
}

function extractMetadata(html: string, pageUrl: string): UnfurledData {
	const head = headOf(html)
	const og: Record<string, string> = {}
	const twitter: Record<string, string> = {}
	let description: string | undefined
	let title: string | undefined
	let icon: string | undefined
	let appleIcon: string | undefined

	for (const match of head.matchAll(TAG_PATTERN)) {
		const tag = match[1].toLowerCase()
		const attributes = attributesOf(match[2])

		if (tag === 'title') {
			// The first title wins, matching the streaming rewriter this replaced.
			title ??= match[3].trim() || undefined
			continue
		}

		if (tag === 'meta') {
			const content = attributes.content
			if (content === undefined) continue
			const property = attributes.property?.toLowerCase()
			const name = attributes.name?.toLowerCase()
			if (property?.startsWith('og:')) og[property] ??= content
			if (name?.startsWith('twitter:')) twitter[name] ??= content
			if (name === 'description') description ??= content
			continue
		}

		// link
		const rel = attributes.rel?.toLowerCase().split(/\s+/) ?? []
		if (!attributes.href) continue
		if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) {
			appleIcon ??= attributes.href
		} else if (rel.includes('icon') || rel.includes('shortcut')) {
			icon ??= attributes.href
		}
	}

	let image: string | undefined =
		og['og:image:secure_url'] ?? og['og:image'] ?? twitter['twitter:image']
	let favicon: string | undefined = appleIcon ?? icon

	if (image && !image.startsWith('http')) image = resolve(image, pageUrl)
	if (favicon && !favicon.startsWith('http')) favicon = resolve(favicon, pageUrl)

	return {
		title: og['og:title'] ?? twitter['twitter:title'] ?? title,
		description: og['og:description'] ?? twitter['twitter:description'] ?? description,
		image,
		favicon,
		// Prefer the OpenGraph image dimensions, falling back to the Twitter player card dimensions
		// (some providers, e.g. Vimeo, report both; others only one).
		imageWidth:
			parseDimension(og['og:image:width']) ?? parseDimension(twitter['twitter:player:width']),
		imageHeight:
			parseDimension(og['og:image:height']) ?? parseDimension(twitter['twitter:player:height']),
	}
}

function resolve(href: string, base: string): string | undefined {
	try {
		return new URL(href, base).href
	} catch {
		return undefined
	}
}

/**
 * An OpenGraph dimension (a string number of pixels) as a positive number, or undefined when it is
 * missing or not a valid positive integer.
 */
function parseDimension(value: string | undefined): number | undefined {
	if (typeof value !== 'string') return undefined
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}
