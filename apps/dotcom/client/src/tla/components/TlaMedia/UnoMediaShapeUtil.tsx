import { type MouseEvent as ReactMouseEvent, type ReactNode, useCallback } from 'react'
import {
	HTMLContainer,
	SvgExportContext,
	TLVideoAsset,
	TLVideoShape,
	VideoShapeUtil,
	useEditor,
	useValue,
} from 'tldraw'
import { useMsg } from '../../utils/i18n'
import { mediaMessages } from './media-messages'
import { getMediaLabel, isAudioAsset } from './media-shared'
import { getOpenMediaShapeId, openMediaPlayer } from './mediaOverlayState'
import styles from './media.module.css'

/**
 * The video shape, taught to carry audio and to hand playback to the overlay player.
 *
 * Playback deliberately does not happen in the shape itself: the canvas scales it, so a transport
 * bar drawn there would be unusably small when zoomed out and huge when zoomed in, and the shape's
 * DOM is recreated as it moves in and out of the viewport. The shape shows a poster and a play
 * button; {@link TlaMediaOverlay} draws the controls at a fixed size beside it.
 */
export class UnoMediaShapeUtil extends VideoShapeUtil {
	// Double-clicking a video would otherwise enter "editing" and expose the browser's own controls
	// inside the canvas transform, competing with the overlay for the same job.
	override canEdit() {
		return false
	}

	override component(shape: TLVideoShape) {
		const asset = shape.props.assetId ? this.editor.getAsset(shape.props.assetId) : null
		if (isAudioAsset(asset)) {
			return <AudioCard shape={shape} asset={asset} />
		}
		return <VideoCard shape={shape}>{super.component(shape)}</VideoCard>
	}

	override async toSvg(shape: TLVideoShape, ctx: SvgExportContext) {
		const asset = shape.props.assetId ? this.editor.getAsset(shape.props.assetId) : null
		// Audio has no frame to grab; export the card instead of failing the whole export.
		if (isAudioAsset(asset)) {
			return (
				<g>
					<rect
						width={shape.props.w}
						height={shape.props.h}
						rx={12}
						fill="var(--tl-color-low)"
						stroke="var(--tl-color-low-border)"
					/>
					<text x={20} y={shape.props.h / 2 + 5} fontSize={14} fill="var(--tl-color-text-1)">
						{asset.props.name}
					</text>
				</g>
			)
		}
		return super.toSvg(shape, ctx)
	}
}

/** The play affordance shared by both cards. A real button, so it is keyboard-reachable. */
function PlayButton({ shape, big }: { shape: TLVideoShape; big?: boolean }) {
	const label = useMsg(mediaMessages.play)
	const isOpen = useValue('is media player open', () => getOpenMediaShapeId().get() === shape.id, [
		shape.id,
	])
	const editor = useEditor()

	const handleClick = useCallback(
		(e: ReactMouseEvent) => {
			// The canvas would otherwise read this as a click on the shape and start a drag.
			e.stopPropagation()
			editor.select(shape.id)
			openMediaPlayer(shape.id)
		},
		[editor, shape.id]
	)

	return (
		<button
			type="button"
			className={big ? styles.playButtonLarge : styles.playButton}
			onPointerDown={(e) => e.stopPropagation()}
			onClick={handleClick}
			aria-label={label}
			title={label}
			aria-pressed={isOpen}
		>
			<svg viewBox="0 0 24 24" aria-hidden focusable="false">
				<path d="M9 6.5 18 12l-9 5.5z" fill="currentColor" />
			</svg>
		</button>
	)
}

function AudioCard({ shape, asset }: { shape: TLVideoShape; asset: TLVideoAsset }) {
	const untitled = useMsg(mediaMessages.untitledAudio)

	return (
		<HTMLContainer id={shape.id} className={styles.audioCard}>
			<PlayButton shape={shape} big />
			<div className={styles.audioCardText}>
				<div className={styles.audioCardName}>{getMediaLabel(asset, untitled)}</div>
				{/* A static waveform mark: the card says "this is audio" without downloading and
				    decoding the file for every card on the board. */}
				<span className={styles.audioCardBars} aria-hidden>
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
				</span>
			</div>
		</HTMLContainer>
	)
}

/** The inline video preview (muted, from the SDK) with our play button over it. */
function VideoCard({ shape, children }: { shape: TLVideoShape; children: ReactNode }) {
	return (
		<>
			{children}
			<div className={styles.videoCardOverlay}>
				<PlayButton shape={shape} />
			</div>
		</>
	)
}
