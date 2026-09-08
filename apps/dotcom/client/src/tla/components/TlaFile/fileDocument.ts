import { fetch } from 'tldraw'

/**
 * Converting between a file's bytes and something the viewer can show or the editor can edit.
 *
 * Everything here loads its heavy dependency dynamically: most boards never open a document, and
 * `mammoth`, `marked`, `dompurify`, `xlsx` and `docx` together are far larger than the rest of the
 * app's chunk.
 */

/** Formats whose content can be edited in the viewer and downloaded as a new file. */
export type EditableFileKind = 'text' | 'markdown' | 'docx'

/** Read-only rendering of a `.docx`, as close to the original as mammoth can carry. */
export async function docxToHtml(arrayBuffer: ArrayBuffer): Promise<string> {
	const mammoth = await import('mammoth')
	const result = await mammoth.convertToHtml(
		{ arrayBuffer },
		{
			// Word's own heading and quote styles, which mammoth otherwise flattens to plain
			// paragraphs — the difference between a document that looks like Word and one that
			// looks like a wall of text.
			styleMap: [
				"p[style-name='Title'] => h1.docx-title:fresh",
				"p[style-name='Subtitle'] => p.docx-subtitle:fresh",
				"p[style-name='Quote'] => blockquote:fresh",
				"p[style-name='Intense Quote'] => blockquote.docx-intense:fresh",
			],
			convertImage: (mammoth as any).images.imgElement(async (image: any) => {
				const base64 = await image.read('base64')
				return { src: `data:${image.contentType};base64,${base64}` }
			}),
		}
	)
	return result.value
}

/** Markdown to HTML, sanitised — the file's author is whoever dropped it on the board. */
export async function markdownToHtml(markdown: string): Promise<string> {
	const [{ marked }, DOMPurify] = await Promise.all([import('marked'), import('dompurify')])
	const html = await marked.parse(markdown, { gfm: true, breaks: false })
	return DOMPurify.default.sanitize(html)
}

export async function xlsxToHtml(arrayBuffer: ArrayBuffer): Promise<string> {
	const [XLSX, DOMPurify] = await Promise.all([import('xlsx'), import('dompurify')])
	const workbook = XLSX.read(arrayBuffer, { type: 'array' })
	const first = workbook.SheetNames[0]
	if (!first) return ''
	return DOMPurify.default.sanitize(XLSX.utils.sheet_to_html(workbook.Sheets[first]))
}

/** Widest a converted image is allowed to be in the rebuilt document, in points (A4 text column). */
const MAX_IMAGE_WIDTH_PT = 450

interface RunSpec {
	text?: string
	bold?: boolean
	italics?: boolean
	underline?: boolean
	strike?: boolean
	font?: string
	link?: string
	image?: { data: Uint8Array; width: number; height: number }
}

/**
 * Rebuilds a `.docx` from the edited HTML the viewer's rich editor produces.
 *
 * Word documents are edited as a document, not as markup — so what comes back here is the same
 * HTML mammoth produced, with the user's changes in it, and this walks it back into Word's own
 * primitives: headings, paragraphs, lists, quotes, tables, images and character formatting.
 * Anything outside that set (footnotes, comments, section layout) was already lost on the way in
 * and cannot be recovered here; the viewer says so before the first edit.
 */
export async function htmlToDocxBlob(html: string): Promise<Blob> {
	const docx = await import('docx')
	const {
		AlignmentType,
		Document,
		HeadingLevel,
		ImageRun,
		Packer,
		Paragraph,
		Table,
		TableCell,
		TableRow,
		TextRun,
		WidthType,
	} = docx

	const body = new DOMParser().parseFromString(html, 'text/html').body
	const headingLevels = [
		HeadingLevel.HEADING_1,
		HeadingLevel.HEADING_2,
		HeadingLevel.HEADING_3,
		HeadingLevel.HEADING_4,
		HeadingLevel.HEADING_5,
		HeadingLevel.HEADING_6,
	]

	// Image bytes have to be read before the document is built: docx takes them synchronously, and
	// measuring a data URL means decoding it.
	const images = new Map<HTMLImageElement, { data: Uint8Array; width: number; height: number }>()
	await Promise.all(
		Array.from(body.querySelectorAll('img')).map(async (img) => {
			const decoded = await decodeImage(img.getAttribute('src'))
			if (decoded) images.set(img, decoded)
		})
	)

	function collectRuns(node: Node, inherited: RunSpec = {}): RunSpec[] {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? ''
			if (!text) return []
			return [{ ...inherited, text }]
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return []

		const el = node as HTMLElement
		const tag = el.tagName.toLowerCase()

		if (tag === 'br') return [{ ...inherited, text: '\n' }]
		if (tag === 'img') {
			const image = images.get(el as HTMLImageElement)
			return image ? [{ image }] : []
		}

		const style: RunSpec = { ...inherited }
		if (tag === 'strong' || tag === 'b') style.bold = true
		if (tag === 'em' || tag === 'i') style.italics = true
		if (tag === 'u' || tag === 'ins') style.underline = true
		if (tag === 's' || tag === 'del' || tag === 'strike') style.strike = true
		if (tag === 'code' || tag === 'kbd' || tag === 'samp') style.font = 'Consolas'
		if (tag === 'a') style.link = el.getAttribute('href') ?? undefined

		return Array.from(el.childNodes).flatMap((child) => collectRuns(child, style))
	}

	function toDocxRuns(specs: RunSpec[]) {
		const runs = specs.map((spec) => {
			if (spec.image) {
				return new ImageRun({
					// The type parameter is required by newer docx versions and inferred from the
					// bytes; PNG covers what a browser hands back from a canvas re-encode.
					type: 'png',
					data: spec.image.data,
					transformation: { width: spec.image.width, height: spec.image.height },
				})
			}
			return new TextRun({
				text: spec.text ?? '',
				bold: spec.bold,
				italics: spec.italics,
				underline: spec.underline ? {} : undefined,
				strike: spec.strike,
				font: spec.font,
				style: spec.link ? 'Hyperlink' : undefined,
			})
		})
		return runs.length > 0 ? runs : [new TextRun('')]
	}

	function blockToParagraphs(el: HTMLElement, listContext?: 'bullet' | 'number'): any[] {
		const tag = el.tagName.toLowerCase()

		if (/^h[1-6]$/.test(tag)) {
			return [
				new Paragraph({
					heading: headingLevels[Number(tag[1]) - 1],
					children: toDocxRuns(collectRuns(el)),
				}),
			]
		}

		if (tag === 'ul' || tag === 'ol') {
			const kind = tag === 'ul' ? 'bullet' : 'number'
			return Array.from(el.children).flatMap((child) =>
				blockToParagraphs(child as HTMLElement, kind)
			)
		}

		if (tag === 'li') {
			const nested = Array.from(el.children).filter((child) =>
				/^(ul|ol)$/i.test(child.tagName)
			) as HTMLElement[]
			const own = Array.from(el.childNodes).filter(
				(child) =>
					!(
						child.nodeType === Node.ELEMENT_NODE &&
						/^(ul|ol)$/i.test((child as HTMLElement).tagName)
					)
			)
			const runs = own.flatMap((child) => collectRuns(child))
			const paragraph = new Paragraph(
				listContext === 'number'
					? { numbering: { reference: 'uno-numbering', level: 0 }, children: toDocxRuns(runs) }
					: { bullet: { level: 0 }, children: toDocxRuns(runs) }
			)
			return [paragraph, ...nested.flatMap((child) => blockToParagraphs(child))]
		}

		if (tag === 'blockquote') {
			return Array.from(el.children).length > 0
				? Array.from(el.children).flatMap((child) => {
						const inner = blockToParagraphs(child as HTMLElement)
						return inner.length > 0
							? inner
							: [new Paragraph({ style: 'IntenseQuote', children: toDocxRuns(collectRuns(child)) })]
					})
				: [new Paragraph({ style: 'IntenseQuote', children: toDocxRuns(collectRuns(el)) })]
		}

		if (tag === 'table') {
			const rows = Array.from(el.querySelectorAll('tr')).map(
				(tr) =>
					new TableRow({
						children: Array.from(tr.children).map(
							(cell) =>
								new TableCell({
									children: [new Paragraph({ children: toDocxRuns(collectRuns(cell)) })],
								})
						),
					})
			)
			return rows.length > 0
				? [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })]
				: []
		}

		if (tag === 'hr') return [new Paragraph({ text: '' })]

		if (tag === 'pre') {
			return (el.textContent ?? '')
				.split('\n')
				.map((line) => new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] }))
		}

		if (tag === 'div' || tag === 'section' || tag === 'article') {
			const children = Array.from(el.children) as HTMLElement[]
			if (children.length > 0) return children.flatMap((child) => blockToParagraphs(child))
		}

		return [
			new Paragraph({
				alignment: el.style.textAlign === 'center' ? AlignmentType.CENTER : undefined,
				children: toDocxRuns(collectRuns(el)),
			}),
		]
	}

	const blocks = Array.from(body.children).flatMap((child) =>
		blockToParagraphs(child as HTMLElement)
	)

	const doc = new Document({
		numbering: {
			config: [
				{
					reference: 'uno-numbering',
					levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }],
				},
			],
		},
		sections: [{ children: blocks.length > 0 ? blocks : [new Paragraph({ text: '' })] }],
	})
	return await Packer.toBlob(doc)
}

/**
 * Reads an image out of a data URL and re-encodes it as PNG at a size that fits the page.
 *
 * Re-encoding rather than passing the original bytes through keeps the format predictable — a
 * pasted image could be any of a dozen types, and docx needs to be told which it is.
 */
async function decodeImage(
	src: string | null
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
	if (!src) return null
	try {
		const response = await fetch(src)
		const blob = await response.blob()
		const bitmap = await createImageBitmap(blob)
		const scale = Math.min(1, MAX_IMAGE_WIDTH_PT / bitmap.width)
		const width = Math.round(bitmap.width * scale)
		const height = Math.round(bitmap.height * scale)

		const canvas = document.createElement('canvas')
		canvas.width = bitmap.width
		canvas.height = bitmap.height
		const context = canvas.getContext('2d')
		if (!context) return null
		context.drawImage(bitmap, 0, 0)
		bitmap.close()

		const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
		if (!png) return null
		return { data: new Uint8Array(await png.arrayBuffer()), width, height }
	} catch {
		// An image that can't be decoded is dropped rather than failing the whole export.
		return null
	}
}

/** Which of the editable formats a file name maps to, or null if it isn't editable. */
export function getEditableKind(name: string): EditableFileKind | null {
	const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
	switch (ext) {
		case 'md':
		case 'markdown':
			return 'markdown'
		case 'txt':
			return 'text'
		case 'docx':
			return 'docx'
		default:
			return null
	}
}

/** The bytes to download for an edited file, and the name to save them under. */
export async function buildDownload(
	kind: EditableFileKind,
	name: string,
	content: string
): Promise<{ blob: Blob; fileName: string }> {
	if (kind === 'docx') {
		return { blob: await htmlToDocxBlob(content), fileName: withSuffix(name, 'docx') }
	}
	const mime = kind === 'markdown' ? 'text/markdown' : 'text/plain'
	return {
		blob: new Blob([content], { type: `${mime};charset=utf-8` }),
		fileName: withSuffix(name, kind === 'markdown' ? 'md' : 'txt'),
	}
}

/** `notes.md` → `notes (edited).md`, so a download never silently shadows the original. */
function withSuffix(name: string, extension: string): string {
	const base = name.replace(/\.[a-z0-9]+$/i, '')
	return `${base} (edited).${extension}`
}
