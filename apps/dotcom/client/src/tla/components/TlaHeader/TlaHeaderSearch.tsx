import { useCallback, useMemo, useRef, useState } from 'react'
import { TLShapeId, useEditor, usePassThroughWheelEvents } from 'tldraw'
import { defineMessages, useMsg } from '../../utils/i18n'
import { formatFileSize } from '../TlaFile/file-shared'
import { TLBoardFileAsset } from '../TlaFile/FileAssetUtil'
import { FILE_CARD_TYPE } from '../TlaFile/FileCardShapeUtil'
import styles from './header.module.css'

const MAX_RESULTS = 20

const messages = defineMessages({
	placeholder: { defaultMessage: 'Search text and files on the board' },
	textResult: { defaultMessage: 'Text' },
	noMatches: { defaultMessage: 'No matches' },
})

interface SearchResult {
	id: TLShapeId
	label: string
	meta: string
}

/**
 * Searches the current page's shapes: plain text pulled from any shape via its ShapeUtil (see
 * ShapeUtil.getText), plus file cards matched by name or by their formatted/raw byte size.
 * Selecting a result selects and zooms to the shape — there's no separate "results panel", the
 * canvas itself is the result view.
 */
export function TlaHeaderSearch() {
	const editor = useEditor()
	const ref = useRef<HTMLDivElement>(null)
	usePassThroughWheelEvents(ref)

	const placeholder = useMsg(messages.placeholder)
	const textResultLbl = useMsg(messages.textResult)
	const noMatchesLbl = useMsg(messages.noMatches)

	const [query, setQuery] = useState('')
	const [isOpen, setIsOpen] = useState(false)

	const results = useMemo<SearchResult[]>(() => {
		const trimmed = query.trim().toLowerCase()
		if (!trimmed) return []

		const matches: SearchResult[] = []
		for (const shape of editor.getCurrentPageShapes()) {
			if (matches.length >= MAX_RESULTS) break

			if (shape.type === FILE_CARD_TYPE) {
				const asset = shape.props.assetId
					? editor.getAsset<TLBoardFileAsset>(shape.props.assetId)
					: undefined
				const name = asset?.props.name?.trim() ?? ''
				const size = asset?.props.size ?? 0
				const sizeLabel = formatFileSize(size)
				const matchesFile =
					name.toLowerCase().includes(trimmed) ||
					sizeLabel.toLowerCase().includes(trimmed) ||
					String(size).includes(trimmed)
				if (matchesFile) {
					matches.push({ id: shape.id, label: name || textResultLbl, meta: sizeLabel })
				}
				continue
			}

			const text = editor.getShapeUtil(shape).getText(shape)
			if (text?.toLowerCase().includes(trimmed)) {
				matches.push({
					id: shape.id,
					label: text.trim().replace(/\s+/g, ' ').slice(0, 80),
					meta: textResultLbl,
				})
			}
		}
		return matches
	}, [editor, query, textResultLbl])

	const handleSelect = useCallback(
		(id: TLShapeId) => {
			editor.select(id)
			editor.zoomToSelection({ animation: { duration: 200 } })
			setIsOpen(false)
		},
		[editor]
	)

	return (
		<div ref={ref} className={styles.search}>
			<input
				className={styles.searchInput}
				type="text"
				value={query}
				placeholder={placeholder}
				data-testid="tla-header-search-input"
				onChange={(e) => {
					setQuery(e.target.value)
					setIsOpen(true)
				}}
				onFocus={() => setIsOpen(true)}
				onBlur={() => {
					// Let a mousedown on a result register before the list disappears.
					setTimeout(() => setIsOpen(false), 150)
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && results[0]) handleSelect(results[0].id)
					else if (e.key === 'Escape') {
						setQuery('')
						setIsOpen(false)
						;(e.target as HTMLInputElement).blur()
					}
				}}
			/>
			{isOpen && query.trim() && (
				<div className={styles.searchResults} data-testid="tla-header-search-results">
					{results.length === 0 ? (
						<div className={styles.searchEmpty}>{noMatchesLbl}</div>
					) : (
						results.map((result) => (
							<button
								key={result.id}
								type="button"
								className={styles.searchResultItem}
								onMouseDown={(e) => {
									// Fires before the input's onBlur would otherwise close the list first.
									e.preventDefault()
									handleSelect(result.id)
								}}
							>
								<span className={styles.searchResultLabel}>{result.label}</span>
								<span className={styles.searchResultMeta}>{result.meta}</span>
							</button>
						))
					)}
				</div>
			)}
		</div>
	)
}
