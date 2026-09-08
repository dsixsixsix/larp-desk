import { useMemo } from 'react'
import { TLShapeId, useEditor, useLocalStorageState, useValue } from 'tldraw'
import { defineMessages, useMsg } from '../../utils/i18n'
import { formatFileSize } from '../TlaFile/file-shared'
import { TLBoardFileAsset } from '../TlaFile/FileAssetUtil'
import { FILE_CARD_TYPE } from '../TlaFile/FileCardShapeUtil'
import { TlaIcon } from '../TlaIcon/TlaIcon'
import styles from './board-sidebar.module.css'

const SIDEBAR_OPEN_KEY = 'tldraw-dotcom:board-sidebar-open'

const messages = defineMessages({
	toggle: { defaultMessage: 'Board outline' },
	frames: { defaultMessage: 'Frames' },
	elements: { defaultMessage: 'Elements' },
	files: { defaultMessage: 'Files' },
	empty: { defaultMessage: 'Nothing here yet' },
	untitledFrame: { defaultMessage: 'Frame' },
	untitledFile: { defaultMessage: 'File' },
})

interface Row {
	id: TLShapeId
	label: string
	meta?: string
}

/** Capitalizes a shape's type name for display when it has no readable text of its own. */
function shapeTypeLabel(type: string): string {
	return type.charAt(0).toUpperCase() + type.slice(1)
}

/**
 * A left-side outline of the current page: frames, everything else ("elements"), and file cards,
 * each clickable to select and zoom to it. Toggled from a fixed button rendered alongside it
 * (see TlaEditorTopPanel, which mounts this only for the local scratch canvas).
 */
export function TlaBoardSidebar() {
	const editor = useEditor()
	const [isOpen, setIsOpen] = useLocalStorageState(SIDEBAR_OPEN_KEY, false)

	const toggleLbl = useMsg(messages.toggle)
	const framesLbl = useMsg(messages.frames)
	const elementsLbl = useMsg(messages.elements)
	const filesLbl = useMsg(messages.files)
	const emptyLbl = useMsg(messages.empty)
	const untitledFrameLbl = useMsg(messages.untitledFrame)
	const untitledFileLbl = useMsg(messages.untitledFile)

	const shapes = useValue('board-sidebar-shapes', () => editor.getCurrentPageShapesSorted(), [
		editor,
	])

	const { frames, elements, files } = useMemo(() => {
		const frames: Row[] = []
		const elements: Row[] = []
		const files: Row[] = []
		for (const shape of shapes) {
			if (shape.type === 'frame') {
				frames.push({ id: shape.id, label: shape.props.name?.trim() || untitledFrameLbl })
			} else if (shape.type === FILE_CARD_TYPE) {
				const asset = shape.props.assetId
					? editor.getAsset<TLBoardFileAsset>(shape.props.assetId)
					: undefined
				files.push({
					id: shape.id,
					label: asset?.props.name?.trim() || untitledFileLbl,
					meta: formatFileSize(asset?.props.size ?? 0),
				})
			} else {
				const text = editor.getShapeUtil(shape).getText(shape)?.trim()
				elements.push({
					id: shape.id,
					label: text ? text.slice(0, 60) : shapeTypeLabel(shape.type),
				})
			}
		}
		return { frames, elements, files }
	}, [shapes, editor, untitledFrameLbl, untitledFileLbl])

	const handleSelect = (id: TLShapeId) => {
		editor.select(id)
		// Pan to the shape without touching the user's current zoom level.
		const bounds = editor.getShapePageBounds(id)
		if (bounds) editor.centerOnPoint(bounds.center, { animation: { duration: 200 } })
	}

	return (
		<>
			<button
				type="button"
				className={styles.toggle}
				data-testid="tla-board-sidebar-toggle"
				aria-pressed={isOpen}
				aria-label={toggleLbl}
				title={toggleLbl}
				onClick={() => setIsOpen(!isOpen)}
			>
				<TlaIcon icon="sidebar" />
			</button>
			{isOpen && (
				<div className={styles.panel} data-testid="tla-board-sidebar">
					<Section title={framesLbl} rows={frames} emptyLbl={emptyLbl} onSelect={handleSelect} />
					<Section
						title={elementsLbl}
						rows={elements}
						emptyLbl={emptyLbl}
						onSelect={handleSelect}
					/>
					<Section title={filesLbl} rows={files} emptyLbl={emptyLbl} onSelect={handleSelect} />
				</div>
			)}
		</>
	)
}

function Section({
	title,
	rows,
	emptyLbl,
	onSelect,
}: {
	title: string
	rows: Row[]
	emptyLbl: string
	onSelect(id: TLShapeId): void
}) {
	return (
		<div className={styles.section}>
			<div className={styles.sectionTitle}>
				<span>{title}</span>
				<span className={styles.count}>{rows.length}</span>
			</div>
			{rows.length === 0 ? (
				<div className={styles.empty}>{emptyLbl}</div>
			) : (
				rows.map((row) => (
					<button
						key={row.id}
						type="button"
						className={styles.row}
						onClick={() => onSelect(row.id)}
					>
						<span className={styles.rowLabel}>{row.label}</span>
						{row.meta && <span className={styles.rowMeta}>{row.meta}</span>}
					</button>
				))
			)}
		</div>
	)
}
