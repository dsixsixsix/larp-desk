import { describe, expect, it } from 'vitest'
import { parsePublicHttpUrl } from './publicUrl'

describe('parsePublicHttpUrl', () => {
	it.each([
		'https://example.com',
		'http://example.com:8080/path?q=1',
		'https://sub.domain.example.co.uk/og.png',
		// Public addresses stay allowed even as literals.
		'https://8.8.8.8/robots.txt',
		'https://[2606:4700:4700::1111]/',
	])('allows %s', (url) => {
		expect(parsePublicHttpUrl(url)?.href).toBeDefined()
	})

	it.each([
		// Schemes that are not a web fetch.
		'ftp://example.com',
		'file:///etc/passwd',
		'data:text/html,hi',
		'javascript:alert(1)',
		// The requesting machine and its network.
		'http://localhost:3000',
		'http://LOCALHOST/',
		'http://app.localhost/',
		'http://printer.local/',
		'http://db.internal/',
		'http://intranet',
		'http://127.0.0.1/',
		'http://127.1.2.3/',
		'http://0.0.0.0/',
		'http://10.0.0.5/',
		'http://172.16.0.1/',
		'http://172.31.255.255/',
		'http://192.168.1.1/',
		'http://100.64.0.1/',
		'http://255.255.255.255/',
		'http://[::1]/',
		'http://[fd00::1]/',
		'http://[fe80::1]/',
		'http://[::ffff:127.0.0.1]/',
		// Link-local, which is where cloud instance metadata lives.
		'http://169.254.169.254/latest/meta-data/',
		'http://169.254.169.254./latest/meta-data/',
		'not a url',
	])('rejects %s', (url) => {
		expect(parsePublicHttpUrl(url)).toBeNull()
	})

	it('keeps 172.32/16 and 100.128/9, which sit just outside the reserved blocks', () => {
		expect(parsePublicHttpUrl('http://172.32.0.1/')).not.toBeNull()
		expect(parsePublicHttpUrl('http://100.128.0.1/')).not.toBeNull()
	})
})
