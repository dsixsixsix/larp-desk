import { memo, useEffect } from 'react'
import {
	defaultHandleExternalFileContent,
	parseAndLoadDocument,
	useDialogs,
	useEditor,
	useToasts,
	useTranslation,
} from 'tldraw'
import { EXTENSION_MIME_FALLBACKS } from '../tla/components/TlaFile/file-shared'
import { useRejectTldrawOfflineFiles } from '../tla/utils/tldrawOfflineFiles'
import { shouldOverrideDocument } from '../utils/shouldOverrideDocument'

/**
 * The editor's file-type matching only looks at `file.type`, but browsers often report `''` for
 * extensions outside their built-in registry (`.md` in particular). Filling it in from the
 * extension here, before the file reaches `defaultHandleExternalFileContent`, is what lets those
 * files match `FileAssetUtil` instead of being silently rejected.
 */
function normalizeFileMimeTypes(files: File[]): File[] {
	return files.map((file) => {
		if (file.type) return file
		const ext = /\.[a-z0-9]+$/i.exec(file.name)?.[0].toLowerCase()
		const fallback = ext ? EXTENSION_MIME_FALLBACKS[ext] : undefined
		return fallback
			? new File([file], file.name, { type: fallback, lastModified: file.lastModified })
			: file
	})
}

export const SneakyOnDropOverride = memo(function SneakyOnDropOverride({
	isMultiplayer,
}: {
	isMultiplayer: boolean
}) {
	const editor = useEditor()
	const toasts = useToasts()
	const dialogs = useDialogs()
	const msg = useTranslation()
	const rejectTldrawOfflineFiles = useRejectTldrawOfflineFiles()

	useEffect(() => {
		editor.registerExternalContentHandler('files', async (content) => {
			const files = normalizeFileMimeTypes(rejectTldrawOfflineFiles(content.files))
			const tldrawFiles = files.filter((file) => file.name.endsWith('.tldr'))
			if (tldrawFiles.length > 0) {
				if (isMultiplayer) {
					toasts.addToast({
						title: msg('file-system.shared-document-file-open-error.title'),
						description: msg('file-system.shared-document-file-open-error.description'),
						severity: 'error',
					})
				} else {
					const shouldOverride = await shouldOverrideDocument(dialogs.addDialog)
					if (!shouldOverride) return
					await parseAndLoadDocument(editor, await tldrawFiles[0].text(), msg, toasts.addToast)
				}
			} else if (files.length > 0) {
				await defaultHandleExternalFileContent(editor, { ...content, files }, { toasts, msg })
			}
		})
	}, [isMultiplayer, editor, toasts, msg, dialogs, rejectTldrawOfflineFiles])

	return null
})
