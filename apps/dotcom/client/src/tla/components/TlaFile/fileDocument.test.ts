import { describe, expect, it } from 'vitest'
import { buildDownload, getEditableKind, htmlToDocxBlob, markdownToHtml } from './fileDocument'
import { tokenizeJson } from './jsonHighlight'

describe('getEditableKind', () => {
	it('maps the editable text formats', () => {
		expect(getEditableKind('notes.md')).toBe('markdown')
		expect(getEditableKind('notes.markdown')).toBe('markdown')
		expect(getEditableKind('notes.txt')).toBe('text')
		expect(getEditableKind('report.docx')).toBe('docx')
	})

	it('ignores case and leaves the read-only formats alone', () => {
		expect(getEditableKind('REPORT.DOCX')).toBe('docx')
		expect(getEditableKind('data.json')).toBeNull()
		expect(getEditableKind('scan.pdf')).toBeNull()
		expect(getEditableKind('sheet.xlsx')).toBeNull()
		expect(getEditableKind('no-extension')).toBeNull()
	})
})

describe('buildDownload', () => {
	it('names the copy so it never shadows the original', async () => {
		const { fileName } = await buildDownload('markdown', 'notes.md', '# hi')
		expect(fileName).toBe('notes (edited).md')
	})

	it('keeps text as text', async () => {
		const { blob, fileName } = await buildDownload('text', 'log.txt', 'line one\nline two')
		expect(fileName).toBe('log (edited).txt')
		expect(blob.type).toContain('text/plain')
		expect(await blob.text()).toBe('line one\nline two')
	})

	it('builds a real docx from the edited document', async () => {
		const { blob, fileName } = await buildDownload(
			'docx',
			'report.docx',
			'<h1>Title</h1><p>Some <strong>bold</strong> text.</p><ul><li>one</li><li>two</li></ul>'
		)
		expect(fileName).toBe('report (edited).docx')
		// A .docx is a zip: the first two bytes are the local file header signature.
		const header = new Uint8Array(await blob.arrayBuffer()).slice(0, 2)
		expect([header[0], header[1]]).toEqual([0x50, 0x4b])
		expect(blob.size).toBeGreaterThan(0)
	})
})

describe('htmlToDocxBlob', () => {
	/** Reads the main document part out of the .docx zip so its XML can be asserted on. */
	async function readDocumentXml(blob: Blob): Promise<string> {
		const JSZip = (await import('jszip')).default
		const zip = await JSZip.loadAsync(await blob.arrayBuffer())
		return await zip.file('word/document.xml')!.async('string')
	}

	it('keeps headings as headings', async () => {
		const xml = await readDocumentXml(await htmlToDocxBlob('<h1>Title</h1><h2>Section</h2>'))
		expect(xml).toContain('Heading1')
		expect(xml).toContain('Heading2')
		expect(xml).toContain('Title')
		expect(xml).toContain('Section')
	})

	it('keeps character formatting', async () => {
		const xml = await readDocumentXml(
			await htmlToDocxBlob('<p><strong>bold</strong> <em>italic</em> <u>under</u></p>')
		)
		expect(xml).toContain('<w:b/>')
		expect(xml).toContain('<w:i/>')
		expect(xml).toContain('<w:u w:val="single"/>')
	})

	it('keeps lists as lists', async () => {
		const xml = await readDocumentXml(
			await htmlToDocxBlob('<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>')
		)
		expect(xml).toContain('numPr')
		expect(xml).toContain('one')
		expect(xml).toContain('first')
	})

	it('keeps tables as tables', async () => {
		const xml = await readDocumentXml(
			await htmlToDocxBlob('<table><tr><td>Metric</td><td>Value</td></tr></table>')
		)
		expect(xml).toContain('<w:tbl>')
		expect(xml).toContain('Metric')
	})

	it('produces a valid file for an empty document', async () => {
		const blob = await htmlToDocxBlob('')
		const header = new Uint8Array(await blob.arrayBuffer()).slice(0, 2)
		expect([header[0], header[1]]).toEqual([0x50, 0x4b])
	})

	it('drops an image it cannot decode rather than failing the whole export', async () => {
		const xml = await readDocumentXml(
			await htmlToDocxBlob('<p>before</p><p><img src="data:image/png;base64,notreallyanimage"></p>')
		)
		expect(xml).toContain('before')
	})
})

describe('markdownToHtml', () => {
	it('renders markdown rather than showing its source', async () => {
		const html = await markdownToHtml('# Heading\n\nSome *emphasis*.')
		expect(html).toContain('<h1')
		expect(html).toContain('Heading')
		expect(html).toContain('<em>emphasis</em>')
	})

	it('strips script tags from an untrusted file', async () => {
		const html = await markdownToHtml('Hello\n\n<script>alert(1)</script>')
		expect(html).not.toContain('<script')
	})

	it('strips inline event handlers', async () => {
		const html = await markdownToHtml('<img src="x" onerror="alert(1)">')
		expect(html).not.toContain('onerror')
	})
})

describe('tokenizeJson', () => {
	function typesOf(source: string) {
		return tokenizeJson(source)
			.filter((t) => t.type !== 'whitespace')
			.map((t) => `${t.type}:${t.value}`)
	}

	it('marks a string as a key only when a colon follows it', () => {
		expect(typesOf('{"a": "b"}')).toEqual([
			'punctuation:{',
			'key:"a"',
			'punctuation::',
			'string:"b"',
			'punctuation:}',
		])
	})

	it('marks a key even when the colon is on the next line', () => {
		expect(typesOf('{\n  "a"\n  : 1\n}')).toContain('key:"a"')
	})

	it('separates numbers, booleans and null', () => {
		expect(typesOf('[1, -2.5, 1e3, true, false, null]')).toEqual([
			'punctuation:[',
			'number:1',
			'punctuation:,',
			'number:-2.5',
			'punctuation:,',
			'number:1e3',
			'punctuation:,',
			'boolean:true',
			'punctuation:,',
			'boolean:false',
			'punctuation:,',
			'null:null',
			'punctuation:]',
		])
	})

	it('keeps escaped quotes inside the string they belong to', () => {
		expect(typesOf('"a \\" b"')).toEqual(['string:"a \\" b"'])
	})

	it('round-trips the source exactly, so nothing is reformatted or dropped', () => {
		const source = '{\n\t"a": [1, null],\n\t"b": "c"\n}\n'
		expect(
			tokenizeJson(source)
				.map((t) => t.value)
				.join('')
		).toBe(source)
	})

	it('flags an unterminated string rather than swallowing the rest of the file', () => {
		const tokens = tokenizeJson('{"a": "unterminated')
		expect(tokens.some((t) => t.type === 'invalid')).toBe(true)
	})

	it('flags junk rather than failing on a malformed file', () => {
		const tokens = tokenizeJson('{"a": undefined}')
		expect(tokens.find((t) => t.value === 'undefined')?.type).toBe('invalid')
	})

	it('handles an empty file', () => {
		expect(tokenizeJson('')).toEqual([])
	})
})
