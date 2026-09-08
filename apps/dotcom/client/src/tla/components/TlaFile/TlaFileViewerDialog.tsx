import classNames from 'classnames'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	TLAssetId,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	useEditor,
	useValue,
} from 'tldraw'
import { useMsg } from '../../utils/i18n'
import { fileMessages } from './file-messages'
import {
	FileAssetLoadState,
	FileViewerKind,
	getFileViewerKind,
	useBlobUrl,
	useFileAssetBlob,
} from './file-shared'
import { TLBoardFileAsset } from './FileAssetUtil'
import {
	EditableFileKind,
	buildDownload,
	docxToHtml,
	getEditableKind,
	markdownToHtml,
	xlsxToHtml,
} from './fileDocument'
import { JsonView } from './JsonView'
import styles from './file.module.css'

/**
 * Opens a file card for viewing and, for the text-shaped formats, editing.
 *
 * Each format is shown as it would be in the tool it belongs to rather than as its bytes: `.docx`
 * on a page, Markdown rendered, JSON syntax-highlighted, `.pdf` in the browser's own viewer.
 * `.md`, `.txt` and `.docx` can also be edited and downloaded as a new file — the asset on the
 * board is left alone, since the same asset can be referenced from more than one card.
 */
export function TlaFileViewerDialog({ assetId }: { onClose(): void; assetId: TLAssetId }) {
	const editor = useEditor()
	const asset = useValue('file-viewer-asset', () => editor.getAsset<TLBoardFileAsset>(assetId), [
		editor,
		assetId,
	])
	const untitledLbl = useMsg(fileMessages.untitled)
	const descriptionLbl = useMsg(fileMessages.description)
	const descriptionPlaceholder = useMsg(fileMessages.descriptionPlaceholder)
	const downloadLbl = useMsg(fileMessages.download)

	const name = asset?.props.name?.trim() || untitledLbl
	const kind = getFileViewerKind(name)
	const editableKind = getEditableKind(name)

	const [reloadKey, setReloadKey] = useState(0)
	const load = useFileAssetBlob(assetId, reloadKey)
	// The dialog owns this URL, so the download link can't be broken by a store teardown the way a
	// URL borrowed from the asset cache can — see useFileAssetBlob.
	const downloadUrl = useBlobUrl(load.status === 'ready' ? load.blob : null)

	const [description, setDescription] = useState(asset?.props.description ?? '')
	useEffect(() => {
		setDescription(asset?.props.description ?? '')
	}, [asset?.id, asset?.props.description])

	const commitDescription = () => {
		if (!asset) return
		const trimmed = description.trim()
		const current = asset.props.description ?? ''
		if (trimmed === current) return
		editor.updateAssets([
			{ ...asset, props: { ...asset.props, description: trimmed || null } } as typeof asset,
		])
	}

	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>{name}</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody className={styles.viewerBody}>
				{asset && (
					<>
						<FileViewerContent
							kind={kind}
							editableKind={editableKind}
							load={load}
							name={name}
							onRetry={() => setReloadKey((k) => k + 1)}
						/>
						<div className={styles.viewerDescription}>
							<div className={styles.viewerDescriptionLabel}>{descriptionLbl}</div>
							<textarea
								className={styles.viewerDescriptionInput}
								value={description}
								placeholder={descriptionPlaceholder}
								onChange={(e) => setDescription(e.target.value)}
								onBlur={commitDescription}
							/>
						</div>
						{downloadUrl && (
							<a className={styles.viewerDownload} href={downloadUrl} download={name}>
								{downloadLbl}
							</a>
						)}
					</>
				)}
			</TldrawUiDialogBody>
		</>
	)
}

type ContentState =
	| { status: 'loading' }
	| { status: 'error' }
	/** `text` is the editable source for .md/.txt; `html` is what the preview renders. */
	| { status: 'ready'; text?: string; html?: string }

function FileViewerContent({
	kind,
	editableKind,
	load,
	name,
	onRetry,
}: {
	kind: FileViewerKind
	editableKind: EditableFileKind | null
	load: FileAssetLoadState
	name: string
	onRetry(): void
}) {
	const unsupportedLbl = useMsg(fileMessages.unsupported)
	const loadingLbl = useMsg(fileMessages.loading)
	const loadErrorLbl = useMsg(fileMessages.loadError)
	const missingLbl = useMsg(fileMessages.notUploaded)
	const retryLbl = useMsg(fileMessages.retry)
	const editLbl = useMsg(fileMessages.edit)
	const previewLbl = useMsg(fileMessages.preview)
	const downloadEditedLbl = useMsg(fileMessages.downloadEdited)
	const docxEditWarning = useMsg(fileMessages.docxEditWarning)
	const revertLbl = useMsg(fileMessages.revert)

	const [state, setState] = useState<ContentState>({ status: 'loading' })
	const [isEditing, setIsEditing] = useState(false)
	/** The edit in progress, or null while the file is still as it was loaded. */
	const [draftText, setDraftText] = useState<string | null>(null)
	const [draftHtml, setDraftHtml] = useState<string | null>(null)

	const blob = load.status === 'ready' ? load.blob : null
	const pdfUrl = useBlobUrl(kind === 'pdf' ? blob : null)

	useEffect(() => {
		setIsEditing(false)
		setDraftText(null)
		setDraftHtml(null)
		if (!blob || kind === 'unsupported' || kind === 'pdf') {
			setState({ status: 'ready' })
			return
		}
		let cancelled = false
		setState({ status: 'loading' })
		;(async () => {
			if (kind === 'text') {
				const text = await blob.text()
				if (cancelled) return
				// Markdown is shown rendered, like it would be anywhere it's published; .txt and
				// .json are shown as written, because that *is* how they look.
				const html = editableKind === 'markdown' ? await markdownToHtml(text) : undefined
				if (!cancelled) setState({ status: 'ready', text, html })
				return
			}
			const arrayBuffer = await blob.arrayBuffer()
			const html = kind === 'docx' ? await docxToHtml(arrayBuffer) : await xlsxToHtml(arrayBuffer)
			if (!cancelled) setState({ status: 'ready', html })
		})().catch(() => {
			if (!cancelled) setState({ status: 'error' })
		})
		return () => {
			cancelled = true
		}
	}, [kind, blob, editableKind])

	const originalHtml = state.status === 'ready' ? (state.html ?? '') : ''
	const originalText = state.status === 'ready' ? (state.text ?? '') : ''
	// A Word file is edited as a document, so its draft is HTML; .md and .txt are edited as text.
	const isRichEdit = editableKind === 'docx'
	const currentText = draftText ?? originalText
	const currentHtml = draftHtml ?? originalHtml
	const isDirty = isRichEdit
		? draftHtml !== null && draftHtml !== originalHtml
		: draftText !== null && draftText !== originalText

	// Keep the Markdown preview showing the edit rather than the file it started from.
	useEffect(() => {
		if (editableKind !== 'markdown' || draftText === null) return
		let cancelled = false
		markdownToHtml(draftText).then((html) => {
			if (!cancelled) setDraftHtml(html)
		})
		return () => {
			cancelled = true
		}
	}, [draftText, editableKind])

	const handleDownload = useCallback(async () => {
		if (!editableKind) return
		const { blob: outputBlob, fileName } = await buildDownload(
			editableKind,
			name,
			isRichEdit ? currentHtml : currentText
		)
		const objectUrl = URL.createObjectURL(outputBlob)
		const link = document.createElement('a')
		link.href = objectUrl
		link.download = fileName
		link.click()
		// Revoked on a timeout rather than immediately: Safari reads the href after the click
		// returns, and a revoked URL there downloads an empty file.
		setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
	}, [editableKind, name, isRichEdit, currentHtml, currentText])

	if (load.status === 'loading') return <div className={styles.viewerMessage}>{loadingLbl}</div>
	if (load.status === 'missing') return <div className={styles.viewerMessage}>{missingLbl}</div>
	if (load.status === 'unreadable') {
		return (
			<div className={styles.viewerMessage}>
				<div>{loadErrorLbl}</div>
				<button type="button" className={styles.viewerRetry} onClick={onRetry}>
					{retryLbl}
				</button>
			</div>
		)
	}
	if (kind === 'unsupported') return <div className={styles.viewerMessage}>{unsupportedLbl}</div>
	if (kind === 'pdf')
		return <iframe className={styles.viewerFrame} src={pdfUrl ?? ''} title={name} />
	if (state.status === 'loading') return <div className={styles.viewerMessage}>{loadingLbl}</div>
	if (state.status === 'error') {
		return (
			<div className={styles.viewerMessage}>
				<div>{loadErrorLbl}</div>
				<button type="button" className={styles.viewerRetry} onClick={onRetry}>
					{retryLbl}
				</button>
			</div>
		)
	}

	return (
		<div className={styles.viewerPane}>
			{editableKind && (
				<div className={styles.viewerToolbar}>
					<div className={styles.viewerTabs} role="tablist">
						<button
							type="button"
							role="tab"
							aria-selected={!isEditing}
							className={styles.viewerTab}
							data-testid="tla-file-tab-preview"
							onClick={() => setIsEditing(false)}
						>
							{previewLbl}
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={isEditing}
							className={styles.viewerTab}
							data-testid="tla-file-tab-edit"
							onClick={() => setIsEditing(true)}
						>
							{editLbl}
						</button>
					</div>
					<div className={styles.viewerToolbarActions}>
						{isDirty && (
							<button
								type="button"
								className={styles.viewerTextButton}
								onClick={() => {
									setDraftText(null)
									setDraftHtml(null)
								}}
							>
								{revertLbl}
							</button>
						)}
						<button
							type="button"
							className={styles.viewerPrimaryButton}
							data-testid="tla-file-download-edited"
							onClick={handleDownload}
						>
							{downloadEditedLbl}
						</button>
					</div>
				</div>
			)}

			{isRichEdit && isEditing && <div className={styles.viewerNotice}>{docxEditWarning}</div>}

			{isEditing ? (
				isRichEdit ? (
					<RichDocumentEditor html={currentHtml} onChange={setDraftHtml} />
				) : (
					<textarea
						className={styles.viewerEditor}
						value={currentText}
						spellCheck={false}
						data-testid="tla-file-editor"
						onChange={(e) => setDraftText(e.target.value)}
						// The canvas listens for single-key shortcuts on the document; typing here is
						// not a shortcut.
						onKeyDown={(e) => e.stopPropagation()}
					/>
				)
			) : (
				<PreviewBody kind={kind} name={name} html={currentHtml} text={currentText} />
			)}
		</div>
	)
}

/**
 * The `.docx` editor: the rendered document itself, made editable in place.
 *
 * A Word file has no source a person would want to see — showing its Markdown means base64 image
 * blobs and anchor markup on screen. Editing the rendered document keeps images as images and
 * headings as headings, and the HTML it produces is what htmlToDocxBlob turns back into a file.
 */
function RichDocumentEditor({ html, onChange }: { html: string; onChange(html: string): void }) {
	const ref = useRef<HTMLDivElement>(null)
	// Only seeded once per document: writing `html` back into the node on every change would move
	// the caret to the start on every keystroke.
	const seeded = useRef<string | null>(null)

	useEffect(() => {
		const node = ref.current
		if (!node || seeded.current === html) return
		if (seeded.current === null) {
			node.innerHTML = html
			seeded.current = html
		}
	}, [html])

	return (
		<div
			ref={ref}
			className={classNames(styles.viewerEditorRich, styles.viewerPage)}
			contentEditable
			suppressContentEditableWarning
			role="textbox"
			aria-multiline
			spellCheck={false}
			data-testid="tla-file-editor-rich"
			onInput={(e) => onChange((e.currentTarget as HTMLDivElement).innerHTML)}
			// The canvas listens for single-key shortcuts on the document; typing here is not a
			// shortcut.
			onKeyDown={(e) => e.stopPropagation()}
		/>
	)
}

function PreviewBody({
	kind,
	name,
	html,
	text,
}: {
	kind: FileViewerKind
	name: string
	html?: string
	text: string
}) {
	const isJson = useMemo(() => /\.json$/i.test(name), [name])

	if (isJson) return <JsonView source={text} />
	if (html) {
		return (
			<div
				className={classNames(styles.viewerHtml, {
					// docx and markdown get the page treatment; a spreadsheet is a grid, not a page.
					[styles.viewerPage]: kind === 'docx' || kind === 'text',
				})}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		)
	}
	return <pre className={styles.viewerText}>{text}</pre>
}
