/**
 * The check that keeps a URL the user chose from aiming a worker's `fetch` somewhere the user
 * could not reach themselves.
 *
 * A worker has no resolver — there is no `node:dns` here — so this cannot follow a hostname to the
 * addresses it answers with, and a name pointed at a private address still gets through. What it
 * can do is refuse the forms that need no resolution to be dangerous: an address literal in a
 * range that belongs to somebody's network, and the names that mean "this machine" or "this LAN"
 * everywhere. That covers the whole of the cheap, scripted version of this attack and none of the
 * patient one, which is why the callers pair it with a rate limit rather than relying on it alone.
 */

/** Reserved IPv4 space, as [first octet, mask, network] tuples over the packed address. */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [network: number, prefix: number]> = [
	[0x00000000, 8], // 0.0.0.0/8 "this network"
	[0x0a000000, 8], // 10/8 private
	[0x7f000000, 8], // 127/8 loopback
	[0xa9fe0000, 16], // 169.254/16 link-local, and with it the cloud metadata address
	[0xac100000, 12], // 172.16/12 private
	[0xc0000000, 24], // 192.0.0/24 IETF protocol assignments
	[0xc0a80000, 16], // 192.168/16 private
	[0x64400000, 10], // 100.64/10 carrier-grade NAT
	[0xe0000000, 4], // 224/4 multicast
	[0xf0000000, 4], // 240/4 reserved, includes 255.255.255.255
]

/** Hostnames that resolve inside the requesting network wherever they are asked. */
const BLOCKED_HOSTNAME_SUFFIXES = ['localhost', '.localhost', '.local', '.internal', '.home.arpa']

function parseIpv4(hostname: string): number | null {
	const parts = hostname.split('.')
	if (parts.length !== 4) return null
	let packed = 0
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const octet = Number(part)
		if (octet > 255) return null
		packed = (packed << 8) | octet
	}
	return packed >>> 0
}

function isBlockedIpv4(packed: number): boolean {
	return BLOCKED_IPV4_RANGES.some(([network, prefix]) => {
		const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
		return (packed & mask) >>> 0 === (network & mask) >>> 0
	})
}

/** The address as its eight 16-bit groups, or `null` if it is not one. */
function expandIpv6(address: string): number[] | null {
	const [head, tail, ...rest] = address.split('::')
	if (rest.length) return null

	const toGroups = (part: string) =>
		part === ''
			? []
			: part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))

	const left = toGroups(head)
	const right = tail === undefined ? [] : toGroups(tail)
	if ([...left, ...right].some(Number.isNaN)) return null

	if (tail === undefined) return left.length === 8 ? left : null
	const fill = 8 - left.length - right.length
	if (fill < 1) return null
	return [...left, ...Array(fill).fill(0), ...right]
}

function isBlockedIpv6(hostname: string): boolean {
	// URL canonicalises a bracketed address, so `::ffff:127.0.0.1` arrives as `::ffff:7f00:1` —
	// hence the expansion rather than matching on the text.
	const groups = expandIpv6(hostname.replace(/^\[|\]$/g, '').toLowerCase())
	if (!groups) return false

	// ::/128 unspecified and ::1/128 loopback.
	if (groups.slice(0, 7).every((g) => g === 0) && groups[7] <= 1) return true
	// fc00::/7 unique-local, fe80::/10 link-local.
	if ((groups[0] & 0xfe00) === 0xfc00) return true
	if ((groups[0] & 0xffc0) === 0xfe80) return true

	// ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible): an IPv4 address in IPv6
	// clothing, and the ranges that are private there are private here too.
	const leadingZeros = groups.slice(0, 5).every((g) => g === 0)
	if (leadingZeros && (groups[5] === 0xffff || groups[5] === 0)) {
		return isBlockedIpv4(((groups[6] << 16) | groups[7]) >>> 0)
	}
	return false
}

/**
 * The URL as a `URL`, or `null` if it is not one a worker should fetch on a caller's behalf.
 *
 * Rejects anything but http and https, and any host that names the requesting network rather than
 * somewhere on the public internet.
 */
export function parsePublicHttpUrl(raw: string): URL | null {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

	const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
	if (!hostname) return null

	if (BLOCKED_HOSTNAME_SUFFIXES.some((s) => hostname === s || hostname.endsWith(s))) return null

	if (hostname.startsWith('[')) {
		return isBlockedIpv6(hostname) ? null : url
	}

	const packed = parseIpv4(hostname)
	if (packed !== null) {
		return isBlockedIpv4(packed) ? null : url
	}

	// A bare label with no dot ("intranet", "router") only resolves through a search domain, which
	// means it only ever names something on the requester's own network.
	if (!hostname.includes('.')) return null

	return url
}
