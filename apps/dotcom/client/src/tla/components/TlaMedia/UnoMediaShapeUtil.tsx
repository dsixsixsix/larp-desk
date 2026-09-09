import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
	HTMLContainer,
	SvgExportContext,
	TLShapeId,
	TLVideoAsset,
	TLVideoShape,
	VideoShapeUtil,
	useEditor,
	useValue,
} from 'tldraw'
import { useMsg } from '../../utils/i18n'
import { mediaMessages } from './media-messages'
import { AUDIO_CARD_H, AUDIO_CARD_W, getMediaLabel, isAudioAsset } from './media-shared'
import {
	getOpenMediaIsPlaying,
	getOpenMediaShapeId,
	openMediaPlayer,
	toggleOpenMediaPlayback,
} from './mediaOverlayState'
import styles from './media.module.css'

/**
 * The video shape, taught to carry audio and to hand audio playback to the overlay player.
 *
 * Audio playback deliberately does not happen in the shape itself: the canvas scales it, so a
 * transport bar drawn there would be unusably small when zoomed out and huge when zoomed in, and
 * the shape's DOM is recreated as it moves in and out of the viewport. The card shows a play button
 * and {@link TlaMediaOverlay} draws the controls at a fixed size beside it.
 *
 * Video keeps its playback in the shape — it is already a picture on the canvas, and the only
 * control it needs is a pause.
 */
export class UnoMediaShapeUtil extends VideoShapeUtil {
	// Double-clicking a video would otherwise enter "editing" and expose the browser's own controls
	// inside the canvas transform, competing with our own button for the same job.
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

/**
 * The play/pause affordance on a card. A real button, so it is keyboard-reachable.
 *
 * `data-media-control` marks it as part of the player rather than the canvas, so the open panel's
 * click-outside handler leaves it alone — see {@link TlaMediaOverlay}.
 */
function TransportButton({
	isPlaying,
	onToggle,
	big,
}: {
	isPlaying: boolean
	onToggle(): void
	big?: boolean
}) {
	const playLbl = useMsg(mediaMessages.play)
	const pauseLbl = useMsg(mediaMessages.pause)
	const label = isPlaying ? pauseLbl : playLbl

	return (
		<button
			type="button"
			className={big ? styles.playButtonLarge : styles.playButton}
			data-media-control
			// The canvas would otherwise read these as a click on the shape and start a drag.
			onPointerDown={(e) => e.stopPropagation()}
			onClick={(e) => {
				e.stopPropagation()
				onToggle()
			}}
			aria-label={label}
			title={label}
			aria-pressed={isPlaying}
		>
			<svg viewBox="0 0 24 24" aria-hidden focusable="false">
				{isPlaying ? (
					<path d="M8 6h3v12H8zm5 0h3v12h-3z" fill="currentColor" />
				) : (
					<path d="M9 6.5 18 12l-9 5.5z" fill="currentColor" />
				)}
			</svg>
		</button>
	)
}

function AudioCard({ shape, asset }: { shape: TLVideoShape; asset: TLVideoAsset }) {
	const untitled = useMsg(mediaMessages.untitledAudio)
	const editor = useEditor()

	const isPlaying = useValue(
		'audio card is playing',
		() => getOpenMediaShapeId().get() === shape.id && getOpenMediaIsPlaying().get(),
		[shape.id]
	)

	const handleToggle = useCallback(() => {
		if (getOpenMediaShapeId().get() === shape.id) {
			toggleOpenMediaPlayback()
			return
		}
		editor.select(shape.id)
		openMediaPlayer(shape.id)
	}, [editor, shape.id])

	return (
		<HTMLContainer id={shape.id}>
			{/* Laid out at the card's default size and scaled to the shape's current bounds, so the
			    play button, name and waveform grow with the box on resize instead of staying pinned
			    at a fixed pixel size — the same trick the file card uses. */}
			<div
				className={styles.audioCard}
				style={{
					width: AUDIO_CARD_W,
					height: AUDIO_CARD_H,
					transform: `scale(${shape.props.w / AUDIO_CARD_W}, ${shape.props.h / AUDIO_CARD_H})`,
					transformOrigin: 'top left',
				}}
			>
				<TransportButton big isPlaying={isPlaying} onToggle={handleToggle} />
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
			</div>
		</HTMLContainer>
	)
}

/** The inline video preview (muted, from the SDK) with our play/pause button over it. */
function VideoCard({ shape, children }: { shape: TLVideoShape; children: ReactNode }) {
	const editor = useEditor()
	const { isPlaying, toggle } = useShapeVideo(shape.id)

	// Hover is the canvas's own idea of it, not the DOM's: the overlay is transparent to the pointer
	// so it never receives :hover, and tldraw hit-tests shapes geometrically anyway. Selection counts
	// too, so the control is still reachable where there is no cursor to hover with.
	const isRevealed = useValue(
		'video controls revealed',
		() =>
			editor.getHoveredShapeId() === shape.id || editor.getSelectedShapeIds().includes(shape.id),
		[editor, shape.id]
	)

	return (
		<>
			{children}
			<div className={styles.videoCardOverlay} data-revealed={isRevealed}>
				<TransportButton big isPlaying={isPlaying} onToggle={toggle} />
			</div>
		</>
	)
}

/**
 * The `<video>` element the SDK renders for a shape, and whether it is playing.
 *
 * The element belongs to the SDK's own component, so we reach it by the per-shape class it puts
 * there — and we look it up on every use rather than holding onto it, because the SDK keys the
 * element on the asset url and swaps in a fresh one when that resolves. A held reference goes stale
 * at that point: the button would drive a detached element while the visible video ignored it.
 */
function useShapeVideo(shapeId: TLShapeId) {
	const editor = useEditor()
	const shapeClass = `tl-video-shape-${shapeId.split(':')[1]}`

	const getVideo = useCallback(
		() => editor.getContainer().querySelector<HTMLVideoElement>(`.${shapeClass}`),
		[editor, shapeClass]
	)

	const [isPlaying, setIsPlaying] = useState(false)

	useEffect(() => {
		const container = editor.getContainer()
		const sync = (e: Event) => {
			const target = e.target as HTMLElement | null
			if (!target?.classList?.contains(shapeClass)) return
			setIsPlaying(!(target as HTMLVideoElement).paused)
		}
		// `play` and `pause` don't bubble, but a capturing listener on an ancestor still sees them.
		// Listening here rather than on the element means a replaced <video> needs no re-subscribing,
		// and that autoplay starting before this shape's controls mount is not missed.
		container.addEventListener('play', sync, true)
		container.addEventListener('pause', sync, true)

		const video = getVideo()
		if (video) setIsPlaying(!video.paused)

		return () => {
			container.removeEventListener('play', sync, true)
			container.removeEventListener('pause', sync, true)
		}
	}, [editor, shapeClass, getVideo])

	const toggle = useCallback(() => {
		const video = getVideo()
		if (!video) return
		if (video.paused) {
			video.play().catch(() => setIsPlaying(false))
		} else {
			video.pause()
		}
	}, [getVideo])

	return { isPlaying, toggle }
}
