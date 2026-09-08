import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react'
import { TLShapeId, TLVideoShape, useEditor, useImageOrVideoAsset, useValue } from 'tldraw'
import { useMsg } from '../../utils/i18n'
import { TlaIcon } from '../TlaIcon/TlaIcon'
import { mediaMessages } from './media-messages'
import { formatMediaTime, getMediaLabel, isAudioAsset } from './media-shared'
import { closeMediaPlayer, getOpenMediaShapeId } from './mediaOverlayState'
import { Waveform } from './Waveform'
import styles from './media.module.css'

/** Distance between the shape's edge and the player, in screen pixels. */
const GAP = 10

/**
 * The player for the currently open audio or video shape, anchored beside it on the canvas.
 *
 * It lives in the `InFrontOfTheCanvas` layer rather than inside the shape so that its controls stay
 * a fixed size at any zoom, and so that playback survives the shape's DOM being recycled as it
 * moves through the viewport. Only one is ever open (see mediaOverlayState).
 */
export function TlaMediaOverlay() {
	const editor = useEditor()
	const shapeId = useValue('open media shape id', () => getOpenMediaShapeId().get(), [])

	const shape = useValue(
		'open media shape',
		() => {
			if (!shapeId) return null
			const s = editor.getShape(shapeId)
			return s?.type === 'video' ? (s as TLVideoShape) : null
		},
		[editor, shapeId]
	)

	// The shape can go away under us — deleted by us or by a collaborator, or left behind when the
	// page changes. Closing in an effect keeps the atom out of render.
	useEffect(() => {
		if (shapeId && !shape) closeMediaPlayer()
	}, [shapeId, shape])

	useEffect(() => {
		if (!shape) return
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') closeMediaPlayer()
		}
		const container = editor.getContainer()
		container.addEventListener('keydown', handleKeyDown)
		return () => container.removeEventListener('keydown', handleKeyDown)
	}, [editor, shape])

	if (!shape) return null
	return <MediaPlayer key={shape.id} shape={shape} />
}

function MediaPlayer({ shape }: { shape: TLVideoShape }) {
	const editor = useEditor()
	const { asset, url } = useImageOrVideoAsset({
		shapeId: shape.id,
		assetId: shape.props.assetId,
		width: shape.props.w,
	})
	const isAudio = isAudioAsset(asset)

	const untitledAudio = useMsg(mediaMessages.untitledAudio)
	const untitledVideo = useMsg(mediaMessages.untitledVideo)
	const closeLbl = useMsg(mediaMessages.close)
	const playLbl = useMsg(mediaMessages.play)
	const pauseLbl = useMsg(mediaMessages.pause)
	const muteLbl = useMsg(mediaMessages.mute)
	const unmuteLbl = useMsg(mediaMessages.unmute)
	const seekLbl = useMsg(mediaMessages.seek)

	const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
	const panelRef = useRef<HTMLDivElement>(null)
	const [isPlaying, setIsPlaying] = useState(false)
	const [isMuted, setIsMuted] = useState(false)
	const [currentTime, setCurrentTime] = useState(0)
	const [duration, setDuration] = useState<number | undefined>(undefined)

	const position = useMediaPlayerPosition(shape.id)

	// Opening the player was a click, so this autoplay is permitted; if a browser refuses it anyway
	// the play button is right there.
	useEffect(() => {
		mediaRef.current?.play().catch(() => setIsPlaying(false))
	}, [url])

	// A click anywhere else on the canvas dismisses the player, the way a popover behaves.
	useEffect(() => {
		const container = editor.getContainer()
		const handlePointerDown = (e: PointerEvent) => {
			if (panelRef.current?.contains(e.target as Node)) return
			closeMediaPlayer()
		}
		container.addEventListener('pointerdown', handlePointerDown)
		return () => container.removeEventListener('pointerdown', handlePointerDown)
	}, [editor])

	const togglePlay = useCallback(() => {
		const media = mediaRef.current
		if (!media) return
		if (media.paused) {
			media.play().catch(() => setIsPlaying(false))
		} else {
			media.pause()
		}
	}, [])

	const seekToRatio = useCallback((ratio: number) => {
		const media = mediaRef.current
		if (!media || !Number.isFinite(media.duration)) return
		media.currentTime = Math.min(1, Math.max(0, ratio)) * media.duration
	}, [])

	const handleScrubPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.currentTarget.setPointerCapture(e.pointerId)
			const rect = e.currentTarget.getBoundingClientRect()
			seekToRatio((e.clientX - rect.left) / rect.width)
		},
		[seekToRatio]
	)

	const handleScrubPointerMove = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
			const rect = e.currentTarget.getBoundingClientRect()
			seekToRatio((e.clientX - rect.left) / rect.width)
		},
		[seekToRatio]
	)

	const handleScrubKeyDown = useCallback((e: ReactKeyboardEvent) => {
		const media = mediaRef.current
		if (!media) return
		// Arrow keys would otherwise nudge the selected shape on the canvas behind us.
		if (e.key === 'ArrowLeft') {
			e.stopPropagation()
			media.currentTime = Math.max(0, media.currentTime - 5)
		} else if (e.key === 'ArrowRight') {
			e.stopPropagation()
			media.currentTime = Math.min(media.duration || 0, media.currentTime + 5)
		}
	}, [])

	if (!position) return null

	const label = getMediaLabel(asset, isAudio ? untitledAudio : untitledVideo)
	const progress = duration ? currentTime / duration : 0
	const timeReadout = `${formatMediaTime(currentTime)} / ${formatMediaTime(duration)}`

	return (
		<div
			ref={panelRef}
			className={styles.playerPanel}
			data-kind={isAudio ? 'audio' : 'video'}
			style={{ left: position.left, top: position.top }}
			// The canvas treats unhandled pointer events as its own; without this, dragging the
			// scrubber pans the board and scrolling over the panel zooms it.
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
			role="group"
			aria-label={label}
		>
			<div className={styles.playerHeader}>
				<div className={styles.playerTitle}>{label}</div>
				<button
					type="button"
					className={styles.playerIconButton}
					onClick={closeMediaPlayer}
					aria-label={closeLbl}
					title={closeLbl}
				>
					<TlaIcon icon="close" />
				</button>
			</div>

			{!isAudio && (
				<video
					ref={mediaRef}
					className={styles.playerVideo}
					src={url ?? undefined}
					playsInline
					onClick={togglePlay}
					onPlay={() => setIsPlaying(true)}
					onPause={() => setIsPlaying(false)}
					onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
					onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
					onVolumeChange={(e) => setIsMuted(e.currentTarget.muted)}
				/>
			)}
			{isAudio && (
				<audio
					ref={mediaRef}
					src={url ?? undefined}
					onPlay={() => setIsPlaying(true)}
					onPause={() => setIsPlaying(false)}
					onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
					onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
					onVolumeChange={(e) => setIsMuted(e.currentTarget.muted)}
				/>
			)}

			<div
				className={styles.playerScrub}
				onPointerDown={handleScrubPointerDown}
				onPointerMove={handleScrubPointerMove}
				onKeyDown={handleScrubKeyDown}
				role="slider"
				tabIndex={0}
				aria-label={seekLbl}
				aria-valuemin={0}
				aria-valuemax={Math.floor(duration ?? 0)}
				aria-valuenow={Math.floor(currentTime)}
				aria-valuetext={formatMediaTime(currentTime)}
			>
				<Waveform url={url} progress={progress} isAudio={isAudio} />
			</div>

			<div className={styles.playerControls}>
				<button
					type="button"
					className={styles.playerPlayButton}
					onClick={togglePlay}
					aria-label={isPlaying ? pauseLbl : playLbl}
					title={isPlaying ? pauseLbl : playLbl}
				>
					<svg viewBox="0 0 24 24" aria-hidden focusable="false">
						{isPlaying ? (
							<path d="M8 6h3v12H8zm5 0h3v12h-3z" fill="currentColor" />
						) : (
							<path d="M9 6.5 18 12l-9 5.5z" fill="currentColor" />
						)}
					</svg>
				</button>

				<div className={styles.playerTime}>{timeReadout}</div>

				<button
					type="button"
					className={styles.playerIconButton}
					onClick={() => {
						const media = mediaRef.current
						if (media) media.muted = !media.muted
					}}
					aria-label={isMuted ? unmuteLbl : muteLbl}
					title={isMuted ? unmuteLbl : muteLbl}
				>
					<svg viewBox="0 0 24 24" aria-hidden focusable="false">
						<path d="M4 9.5h3.2L11 6v12l-3.8-3.5H4z" fill="currentColor" />
						{isMuted ? (
							<path
								d="m14.5 9.5 5 5m0-5-5 5"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								fill="none"
							/>
						) : (
							<path
								d="M14.5 9a4 4 0 0 1 0 6"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								fill="none"
							/>
						)}
					</svg>
				</button>
			</div>
		</div>
	)
}

/**
 * Where to put the panel: under the shape, centred on it, flipped above when the shape sits low in
 * the viewport, and always kept inside the viewport's edges.
 */
function useMediaPlayerPosition(shapeId: TLShapeId) {
	const editor = useEditor()
	return useValue(
		'media player position',
		() => {
			const bounds = editor.getShapePageBounds(shapeId)
			if (!bounds) return null
			const viewport = editor.getViewportScreenBounds()
			const topLeft = editor.pageToViewport({ x: bounds.minX, y: bounds.minY })
			const bottomRight = editor.pageToViewport({ x: bounds.maxX, y: bounds.maxY })

			// The panel's own size isn't known until it renders; these are its CSS bounds, and being
			// a little conservative here only ever pulls the panel further inside the viewport.
			const panelWidth = 380
			const panelHeight = 260

			const centerX = (topLeft.x + bottomRight.x) / 2
			const left = Math.min(
				Math.max(GAP, centerX - panelWidth / 2),
				Math.max(GAP, viewport.w - panelWidth - GAP)
			)
			const below = bottomRight.y + GAP
			const top =
				below + panelHeight > viewport.h ? Math.max(GAP, topLeft.y - panelHeight - GAP) : below
			return { left, top }
		},
		[editor, shapeId]
	)
}
