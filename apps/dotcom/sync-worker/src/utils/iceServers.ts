import { Environment } from '../types'

/**
 * An ICE server as `RTCPeerConnection` takes it. Declared here rather than reusing the DOM's
 * `RTCIceServer`: this is a worker, and the value only has to survive JSON on the way to a browser.
 */
export interface IceServerConfig {
	urls: string[]
	username?: string
	credential?: string
}

/**
 * Address discovery when nothing else is configured. Free and unmetered, and enough on its own for
 * the ordinary home-router case — but only that one. Two peers behind symmetric NAT, a firewall
 * that drops UDP, or most VPNs cannot connect without a relay.
 */
export const DEFAULT_STUN_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53']

/**
 * How long minted TURN credentials stay valid. Only bounds when a *new* connection may present
 * them — coturn keeps an allocation alive past its credential's expiry — so this is sized to be
 * comfortably longer than the gap between a page load and someone turning their microphone on.
 */
export const TURN_CREDENTIAL_TTL_SECONDS = 12 * 60 * 60

/** Splits a comma or whitespace separated list of URLs from an environment variable. */
export function parseUrlList(raw: string | undefined): string[] {
	if (!raw) return []
	return raw
		.split(/[\s,]+/)
		.map((url) => url.trim())
		.filter(Boolean)
}

function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/**
 * Mints a credential pair for a TURN server running in coturn's shared-secret mode
 * (`--use-auth-secret`), as described by the TURN REST API draft: the username is the expiry
 * timestamp, and the password is its HMAC under a secret only the server and this worker know.
 *
 * The point is that no per-user account exists anywhere. The relay validates the HMAC and the
 * timestamp, so a credential that leaks stops working on its own, and nothing has to be revoked.
 */
export async function createEphemeralTurnCredentials(
	secret: string,
	{
		ttlSeconds = TURN_CREDENTIAL_TTL_SECONDS,
		now = Date.now(),
		label = 'unocode',
	}: { ttlSeconds?: number; now?: number; label?: string } = {}
): Promise<{ username: string; credential: string }> {
	const username = `${Math.floor(now / 1000) + ttlSeconds}:${label}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		// SHA-1 is what coturn computes; it is a MAC over a public timestamp under a shared secret,
		// not a collision-sensitive use, and the server side is not ours to change.
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	)
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username))
	return { username, credential: toBase64(new Uint8Array(signature)) }
}

/**
 * How to authenticate to the configured relays, parsed from `TURN_AUTH`.
 *
 * One variable rather than three, so moving between relays is one secret to change:
 *
 * - `secret:<shared secret>` — a coturn running with `--use-auth-secret`. Credentials are minted
 *   per session, so nothing long-lived is ever handed to a browser.
 * - `static:<username>:<credential>` — a relay that only issues long-term credentials. The
 *   credential may itself contain colons; only the first two separators are structural.
 *
 * Anything else is treated as absent, which leaves voice on STUN rather than handing a browser an
 * entry it would reject.
 */
export function parseTurnAuth(
	raw: string | undefined
):
	| { kind: 'secret'; secret: string }
	| { kind: 'static'; username: string; credential: string }
	| null {
	if (!raw) return null
	const separator = raw.indexOf(':')
	if (separator === -1) return null
	const scheme = raw.slice(0, separator)
	const rest = raw.slice(separator + 1)

	if (scheme === 'secret') {
		return rest ? { kind: 'secret', secret: rest } : null
	}
	if (scheme === 'static') {
		const usernameEnd = rest.indexOf(':')
		if (usernameEnd === -1) return null
		const username = rest.slice(0, usernameEnd)
		const credential = rest.slice(usernameEnd + 1)
		return username && credential ? { kind: 'static', username, credential } : null
	}
	return null
}

/**
 * The ICE servers a browser joining a board should use.
 *
 * Entirely environment-driven, so moving between relays is a configuration change rather than a
 * code change — a hosted relay's static credentials today, a self-hosted coturn tomorrow, without
 * touching this file:
 *
 * - `TURN_URLS` — the relays' URLs, comma separated. Include a `turns:` one on 443 if the relay
 *   offers it: TLS on the HTTPS port is the single route that survives a genuinely restrictive
 *   network.
 * - `TURN_AUTH` — how to authenticate to them (see `parseTurnAuth`).
 * - `STUN_URLS` — overrides the default STUN servers.
 *
 * With no usable TURN configuration this returns STUN only, which is a working configuration for
 * everyone whose network does not need relaying and silence for everyone else.
 */
export async function getIceServers(
	env: Environment,
	options?: { now?: number }
): Promise<IceServerConfig[]> {
	const stunUrls = parseUrlList(env.STUN_URLS)
	const iceServers: IceServerConfig[] = [
		{ urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS },
	]

	const turnUrls = parseUrlList(env.TURN_URLS)
	const auth = parseTurnAuth(env.TURN_AUTH)
	if (turnUrls.length === 0 || !auth) return iceServers

	if (auth.kind === 'secret') {
		const { username, credential } = await createEphemeralTurnCredentials(
			auth.secret,
			options?.now === undefined ? {} : { now: options.now }
		)
		iceServers.push({ urls: turnUrls, username, credential })
		return iceServers
	}

	iceServers.push({
		urls: turnUrls,
		username: auth.username,
		credential: auth.credential,
	})
	return iceServers
}
