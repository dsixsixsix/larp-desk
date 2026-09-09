import { describe, expect, it } from 'vitest'
import { Environment } from '../types'
import {
	DEFAULT_STUN_URLS,
	createEphemeralTurnCredentials,
	getIceServers,
	parseTurnAuth,
	parseUrlList,
} from './iceServers'

function env(overrides: Partial<Environment> = {}): Environment {
	return overrides as Environment
}

const TURN_URLS = 'turn:relay.example:3478?transport=udp, turns:relay.example:443?transport=tcp'
const PARSED_TURN_URLS = [
	'turn:relay.example:3478?transport=udp',
	'turns:relay.example:443?transport=tcp',
]

describe('parseUrlList', () => {
	it('splits on commas and whitespace, and drops the gaps', () => {
		expect(parseUrlList(TURN_URLS)).toEqual(PARSED_TURN_URLS)
		expect(parseUrlList('a\nb  c,,d')).toEqual(['a', 'b', 'c', 'd'])
	})

	it('treats an unset or empty variable as no urls', () => {
		expect(parseUrlList(undefined)).toEqual([])
		expect(parseUrlList('   ')).toEqual([])
	})
})

describe('parseTurnAuth', () => {
	it('reads a coturn shared secret', () => {
		expect(parseTurnAuth('secret:s3cr3t')).toEqual({ kind: 'secret', secret: 's3cr3t' })
	})

	it('reads a long-term credential pair', () => {
		expect(parseTurnAuth('static:alice:hunter2')).toEqual({
			kind: 'static',
			username: 'alice',
			credential: 'hunter2',
		})
	})

	it('keeps colons inside the credential', () => {
		expect(parseTurnAuth('static:alice:a:b:c')).toEqual({
			kind: 'static',
			username: 'alice',
			credential: 'a:b:c',
		})
	})

	it('rejects anything it cannot use rather than half-reading it', () => {
		expect(parseTurnAuth(undefined)).toBe(null)
		expect(parseTurnAuth('')).toBe(null)
		expect(parseTurnAuth('s3cr3t')).toBe(null)
		expect(parseTurnAuth('secret:')).toBe(null)
		expect(parseTurnAuth('static:alice')).toBe(null)
		expect(parseTurnAuth('static::hunter2')).toBe(null)
		expect(parseTurnAuth('static:alice:')).toBe(null)
		expect(parseTurnAuth('bearer:whatever')).toBe(null)
	})
})

describe('createEphemeralTurnCredentials', () => {
	it('builds the username from the expiry timestamp', async () => {
		const { username } = await createEphemeralTurnCredentials('s', {
			now: 1_000_000_000_000,
			ttlSeconds: 60,
			label: 'unocode',
		})
		expect(username).toBe('1000000060:unocode')
	})

	it('is deterministic for the same secret and time, and differs across secrets', async () => {
		const at = { now: 1_000_000_000_000, ttlSeconds: 60 }
		const a = await createEphemeralTurnCredentials('one', at)
		const b = await createEphemeralTurnCredentials('one', at)
		const c = await createEphemeralTurnCredentials('two', at)

		expect(a).toEqual(b)
		expect(c.credential).not.toBe(a.credential)
	})

	it('produces a base64 HMAC-SHA1, which is what coturn checks', async () => {
		const { credential } = await createEphemeralTurnCredentials('s', { now: 0, ttlSeconds: 0 })
		// 20 raw bytes of SHA-1 base64-encode to 28 characters with one pad.
		expect(credential).toMatch(/^[A-Za-z0-9+/]{27}=$/)
	})
})

describe('getIceServers', () => {
	it('serves the default STUN servers when nothing is configured', async () => {
		expect(await getIceServers(env())).toEqual([{ urls: DEFAULT_STUN_URLS }])
	})

	it('lets STUN_URLS override the defaults', async () => {
		expect(await getIceServers(env({ STUN_URLS: 'stun:a:3478,stun:b:3478' }))).toEqual([
			{ urls: ['stun:a:3478', 'stun:b:3478'] },
		])
	})

	it('adds a relay with long-term credentials', async () => {
		expect(await getIceServers(env({ TURN_URLS, TURN_AUTH: 'static:alice:hunter2' }))).toEqual([
			{ urls: DEFAULT_STUN_URLS },
			{ urls: PARSED_TURN_URLS, username: 'alice', credential: 'hunter2' },
		])
	})

	it('mints credentials per session for a coturn shared secret', async () => {
		const servers = await getIceServers(env({ TURN_URLS, TURN_AUTH: 'secret:s3cr3t' }), {
			now: 1_000_000_000_000,
		})

		const relay = servers[1]
		expect(relay.urls).toEqual(PARSED_TURN_URLS)
		expect(relay.username).toBe(`${1_000_000_000 + 12 * 60 * 60}:unocode`)
		expect(relay.credential).toBeTruthy()
	})

	it('drops a relay it has no usable credentials for', async () => {
		// A urls-only entry is one a browser rejects, so it must not be handed over at all.
		expect(await getIceServers(env({ TURN_URLS }))).toEqual([{ urls: DEFAULT_STUN_URLS }])
		expect(await getIceServers(env({ TURN_URLS, TURN_AUTH: 'nonsense' }))).toEqual([
			{ urls: DEFAULT_STUN_URLS },
		])
	})

	it('ignores credentials with no relay to use them on', async () => {
		expect(await getIceServers(env({ TURN_AUTH: 'static:alice:hunter2' }))).toEqual([
			{ urls: DEFAULT_STUN_URLS },
		])
	})
})
