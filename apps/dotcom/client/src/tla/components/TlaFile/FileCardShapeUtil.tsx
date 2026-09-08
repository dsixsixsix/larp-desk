import {
	BaseBoxShapeUtil,
	HTMLContainer,
	TLAsset,
	TLAssetId,
	TLBaseShape,
	TLShapePartial,
	TldrawUiIcon,
	VecModel,
	createShapeId,
	useDialogs,
} from 'tldraw'
import { useMsg } from '../../utils/i18n'
import { fileMessages } from './file-messages'
import { formatFileSize, getFileExtensionLabel, useFileAssetUrl } from './file-shared'
import { BOARD_FILE_ASSET_TYPE, TLBoardFileAsset } from './FileAssetUtil'
import { TlaFileViewerDialog } from './TlaFileViewerDialog'
import styles from './file.module.css'

export const FILE_CARD_TYPE = 'board-file-card' as const

export interface TLFileCardShapeProps {
	assetId: TLAssetId | null
	w: number
	h: number
}

export type TLFileCardShape = TLBaseShape<typeof FILE_CARD_TYPE, TLFileCardShapeProps>

declare module 'tldraw' {
	interface TLGlobalShapePropsMap {
		[FILE_CARD_TYPE]: TLFileCardShapeProps
	}
}

const CARD_W = 220
const CARD_H = 72

export class FileCardShapeUtil extends BaseBoxShapeUtil<TLFileCardShape> {
	static override type = FILE_CARD_TYPE
	static override handledAssetTypes = [BOARD_FILE_ASSET_TYPE] as const

	override getDefaultProps(): TLFileCardShape['props'] {
		return { assetId: null, w: CARD_W, h: CARD_H }
	}

	// The card's content (icon + text) is laid out at a fixed aspect ratio and scaled to fit — a
	// free resize would stretch it out of shape, so only proportional resizing is allowed.
	override isAspectRatioLocked() {
		return true
	}

	override createShapeForAsset(asset: TLAsset, position: VecModel): TLShapePartial | null {
		if (asset.type !== BOARD_FILE_ASSET_TYPE) return null
		return {
			id: createShapeId(),
			type: FILE_CARD_TYPE,
			x: position.x,
			y: position.y,
			props: { assetId: asset.id, w: CARD_W, h: CARD_H },
		}
	}

	override component(shape: TLFileCardShape) {
		const asset = shape.props.assetId
			? this.editor.getAsset<TLBoardFileAsset>(shape.props.assetId)
			: undefined
		return <FileCard shape={shape} asset={asset} />
	}

	override getIndicatorPath(shape: TLFileCardShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function FileCard({
	shape,
	asset,
}: {
	shape: TLFileCardShape
	asset: TLBoardFileAsset | undefined
}) {
	const { addDialog } = useDialogs()
	const untitled = useMsg(fileMessages.untitled)
	const downloadLbl = useMsg(fileMessages.download)
	const openLbl = useMsg(fileMessages.open)
	const name = asset?.props.name?.trim() || untitled
	const size = asset?.props.size ?? 0
	const url = useFileAssetUrl(shape.props.assetId)
	const ext = getFileExtensionLabel(name, asset?.props.mimeType)

	const handleOpen = () => {
		if (!shape.props.assetId) return
		const assetId = shape.props.assetId
		addDialog({ component: (props) => <TlaFileViewerDialog {...props} assetId={assetId} /> })
	}

	return (
		<HTMLContainer id={shape.id}>
			{/* The card is laid out at its default size and scaled to fill the shape's current
			    bounds, so the icon and text grow with the box on resize instead of staying pinned
			    at a fixed pixel size — matching how other shapes (e.g. images) fill their frame. */}
			<div
				className={styles.fileCard}
				style={{
					width: CARD_W,
					height: CARD_H,
					transform: `scale(${shape.props.w / CARD_W}, ${shape.props.h / CARD_H})`,
					transformOrigin: 'top left',
				}}
			>
				{url && (
					<a
						className={styles.fileCardDownload}
						href={url}
						download={name}
						title={downloadLbl}
						aria-label={downloadLbl}
						onPointerDown={(e) => e.stopPropagation()}
						onClick={(e) => e.stopPropagation()}
					>
						<TldrawUiIcon icon="download" label={downloadLbl} small />
					</a>
				)}
				<div className={styles.fileCardBadge} aria-hidden>
					{ext}
				</div>
				<div className={styles.fileCardText}>
					<button
						type="button"
						className={`${styles.fileCardName} ${styles.fileCardOpen}`}
						title={openLbl}
						onPointerDown={(e) => e.stopPropagation()}
						onClick={(e) => {
							e.stopPropagation()
							handleOpen()
						}}
					>
						{name}
					</button>
					<div className={styles.fileCardMeta}>{formatFileSize(size)}</div>
				</div>
			</div>
		</HTMLContainer>
	)
}
