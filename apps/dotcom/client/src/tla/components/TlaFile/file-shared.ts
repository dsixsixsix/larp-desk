import { useEffect, useState } from 'react'
import { TLAssetId, fetch, useEditor } from 'tldraw'

/** MIME types the file card accepts, keyed to the extension shown on the card badge. */
export const FILE_CARD_MIME_TYPES: Record<string, string> = {
	'text/markdown': 'md',
	'text/plain': 'txt',
	'application/json': 'json',
	'application/pdf': 'pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

/**
 * Browsers often report no MIME type (or a generic one) for extensions outside their built-in
 * registry — `.md` in particular usually arrives as `''`. The editor's file-type matching only
 * looks at `file.type`, so these files would be silently rejected before `FileAssetUtil` ever
 * sees them. See `SneakyOnDropOverride`, which fills the type in from the extension first.
 */
export const EXTENSION_MIME_FALLBACKS: Record<string, string> = {
	'.md': 'text/markdown',
	'.markdown': 'text/markdown',
	'.txt': 'text/plain',
	'.json': 'application/json',
	'.pdf': 'application/pdf',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function formatFileSize(bytes: number): string {
	if (bytes <= 0) return '0 B'
	const units = ['B', 'KB', 'MB', 'GB']
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
	const value = bytes / Math.pow(1024, i)
	return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[i]}`
}

/** The badge label on the card: the file's own extension, falling back to its MIME type. */
export function getFileExtensionLabel(name: string, mimeType?: string | null): string {
	const match = /\.([a-z0-9]+)$/i.exec(name)
	if (match) return match[1].toUpperCase()
	const fromMime = mimeType ? FILE_CARD_MIME_TYPES[mimeType] : undefined
	return fromMime ? fromMime.toUpperCase() : 'FILE'
}

/**
 * A file asset's `props.src` is an opaque reference (`"asset:<id>"` for the local IndexedDB
 * store), not a usable URL — only `editor.resolveAssetUrl` turns it into one (a `blob:` URL
 * here). Every place that needs to actually load or download a file's bytes has to go through
 * this hook rather than reading `asset.props.src` directly.
 */
export function useFileAssetUrl(assetId: TLAssetId | null): string | null {
	const editor = useEditor()
	const [url, setUrl] = useState<string | null>(null)

	useEffect(() => {
		setUrl(null)
		if (!assetId) return
		let cancelled = false
		editor.resolveAssetUrl(assetId, { shouldResolveToOriginal: true }).then((resolved) => {
			if (!cancelled) setUrl(resolved)
		})
		return () => {
			cancelled = true
		}
	}, [editor, assetId])

	return url
}

export type FileAssetLoadState =
	| { status: 'loading' }
	/** The asset record exists but its bytes don't — an upload that never finished, or cleared storage. */
	| { status: 'missing' }
	| { status: 'unreadable' }
	| { status: 'ready'; blob: Blob }

/**
 * Reads a file asset's actual bytes.
 *
 * Resolving and reading happen together, and what's handed back is the blob rather than a URL.
 * `resolveAssetUrl` mints an object URL owned by the store that created it, and that URL is
 * revoked when the store is torn down — after which it still looks like a perfectly good string
 * but fetches as a network error. Anything holding such a URL across a store change (a dialog
 * that was already open, say) would report a file it can't read as broken. Holding the bytes
 * instead means the only failure left is the file genuinely not being there.
 *
 * `reloadKey` re-runs the read; see the retry in TlaFileViewerDialog.
 */
export function useFileAssetBlob(assetId: TLAssetId | null, reloadKey = 0): FileAssetLoadState {
	const editor = useEditor()
	const [state, setState] = useState<FileAssetLoadState>({ status: 'loading' })

	useEffect(() => {
		setState({ status: 'loading' })
		if (!assetId) {
			setState({ status: 'missing' })
			return
		}
		let cancelled = false
		;(async () => {
			const url = await editor.resolveAssetUrl(assetId, { shouldResolveToOriginal: true })
			if (cancelled) return
			if (!url) {
				setState({ status: 'missing' })
				return
			}
			try {
				const response = await fetch(url)
				if (!response.ok) throw new Error(`Asset request failed: ${response.status}`)
				const blob = await response.blob()
				if (!cancelled) setState({ status: 'ready', blob })
			} catch {
				if (!cancelled) setState({ status: 'unreadable' })
			}
		})()
		return () => {
			cancelled = true
		}
	}, [editor, assetId, reloadKey])

	return state
}

/**
 * An object URL for a blob, owned by the calling component and revoked when it unmounts — for the
 * places that need a URL rather than bytes (an iframe's `src`, a download link's `href`).
 */
export function useBlobUrl(blob: Blob | null): string | null {
	const [url, setUrl] = useState<string | null>(null)

	useEffect(() => {
		if (!blob) {
			setUrl(null)
			return
		}
		const objectUrl = URL.createObjectURL(blob)
		setUrl(objectUrl)
		return () => {
			setUrl(null)
			URL.revokeObjectURL(objectUrl)
		}
	}, [blob])

	return url
}

export type FileViewerKind = 'text' | 'pdf' | 'docx' | 'xlsx' | 'unsupported'

/** Which viewer TlaFileViewerDialog should use, based on the card's extension. */
export function getFileViewerKind(name: string): FileViewerKind {
	const ext = getFileExtensionLabel(name).toLowerCase()
	switch (ext) {
		case 'md':
		case 'markdown':
		case 'txt':
		case 'json':
			return 'text'
		case 'pdf':
			return 'pdf'
		case 'docx':
			return 'docx'
		case 'xlsx':
			return 'xlsx'
		default:
			return 'unsupported'
	}
}
