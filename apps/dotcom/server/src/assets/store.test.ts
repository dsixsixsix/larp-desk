import { describe, expect, it } from 'vitest'
import { MAX_OBJECT_NAME_BYTES, isValidObjectName, safeContentType } from './store'

describe('isValidObjectName', () => {
	it('accepts the names the client mints', () => {
		expect(isValidObjectName('kx8f2n-cat-jpg')).toBe(true)
	})

	it('refuses anything that could address a different object', () => {
		const refused = ['', '.', '..', 'a/b', 'a\\b', '../secret', 'nested/path/file']
		expect(refused.filter(isValidObjectName)).toEqual([])
	})

	it('refuses a name longer than the key limit, counting bytes not characters', () => {
		expect(isValidObjectName('a'.repeat(MAX_OBJECT_NAME_BYTES))).toBe(true)
		expect(isValidObjectName('a'.repeat(MAX_OBJECT_NAME_BYTES + 1))).toBe(false)
		// Multi-byte characters spend more of the budget than their length suggests.
		expect(isValidObjectName('é'.repeat(MAX_OBJECT_NAME_BYTES / 2 + 1))).toBe(false)
	})
})

describe('safeContentType', () => {
	it('keeps a well-formed type, with parameters', () => {
		expect(safeContentType(new Headers({ 'content-type': 'text/plain; charset=utf-8' }))).toBe(
			'text/plain; charset=utf-8'
		)
	})

	it('falls back to a type that commits the browser to nothing', () => {
		// A `content-disposition` smuggled through here would turn an asset URL into a drive-by
		// download from our own domain.
		const rejected = ['', 'attachment; filename=evil.exe', 'not-a-type', 'text/html<script>']
		for (const value of rejected) {
			expect(safeContentType(new Headers({ 'content-type': value }))).toBe(
				'application/octet-stream'
			)
		}
		expect(safeContentType(new Headers())).toBe('application/octet-stream')
	})
})
