/**
 * The token kinds a JSON document can produce. Named after what they are in JSON rather than after
 * a theme's colour names, so the stylesheet decides how each one looks.
 */
export type JsonTokenType =
	| 'key'
	| 'string'
	| 'number'
	| 'boolean'
	| 'null'
	| 'punctuation'
	| 'whitespace'
	| 'invalid'

export interface JsonToken {
	type: JsonTokenType
	value: string
}

const PUNCTUATION = new Set(['{', '}', '[', ']', ':', ','])

/**
 * Tokenises JSON for display.
 *
 * A tokeniser rather than `JSON.parse` + re-serialise, because a file the user is looking at is
 * often one they opened *because* something is wrong with it: re-serialising would silently
 * reformat a valid file and refuse to show an invalid one. This keeps the bytes exactly as they
 * are, and marks anything it can't classify as `invalid` so the stylesheet can flag it.
 *
 * A key is just a string token that the next non-whitespace character turns out to be a `:` — the
 * same rule an editor's syntax highlighter uses, and the reason keys are resolved in a second pass.
 */
export function tokenizeJson(source: string): JsonToken[] {
	const tokens: JsonToken[] = []
	let i = 0

	while (i < source.length) {
		const char = source[i]

		if (/\s/.test(char)) {
			let end = i
			while (end < source.length && /\s/.test(source[end])) end++
			tokens.push({ type: 'whitespace', value: source.slice(i, end) })
			i = end
			continue
		}

		if (PUNCTUATION.has(char)) {
			tokens.push({ type: 'punctuation', value: char })
			i++
			continue
		}

		if (char === '"') {
			let end = i + 1
			while (end < source.length) {
				if (source[end] === '\\') {
					end += 2
					continue
				}
				if (source[end] === '"') {
					end++
					break
				}
				end++
			}
			const value = source.slice(i, end)
			// An unterminated string runs to the end of the file; flag it rather than showing it as
			// a normal string that happens to swallow the rest of the document.
			tokens.push({ type: value.endsWith('"') && value.length > 1 ? 'string' : 'invalid', value })
			i = end
			continue
		}

		const literal = /^(true|false|null)/.exec(source.slice(i))
		if (literal) {
			tokens.push({ type: literal[0] === 'null' ? 'null' : 'boolean', value: literal[0] })
			i += literal[0].length
			continue
		}

		const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i))
		if (number) {
			tokens.push({ type: 'number', value: number[0] })
			i += number[0].length
			continue
		}

		// Anything else: consume up to the next character that could start a valid token, so one
		// broken run doesn't turn the rest of the file into a string of single-character tokens.
		let end = i
		while (end < source.length && !PUNCTUATION.has(source[end]) && !/[\s"]/.test(source[end])) end++
		tokens.push({ type: 'invalid', value: source.slice(i, Math.max(end, i + 1)) })
		i = Math.max(end, i + 1)
	}

	return markKeys(tokens)
}

function markKeys(tokens: JsonToken[]): JsonToken[] {
	return tokens.map((token, index) => {
		if (token.type !== 'string') return token
		for (let i = index + 1; i < tokens.length; i++) {
			const next = tokens[i]
			if (next.type === 'whitespace') continue
			return next.type === 'punctuation' && next.value === ':' ? { ...token, type: 'key' } : token
		}
		return token
	})
}
