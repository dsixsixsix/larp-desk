import { useEffect, useRef, useState } from 'react'
import { WAVEFORM_BUCKETS, getAudioPeaks } from './audioPeaks'
import styles from './media.module.css'

/**
 * The scrub target: a waveform when the file could be decoded, a plain bar when it couldn't.
 *
 * Drawn to a canvas rather than as elements because it repaints on every timeupdate — 160 DOM
 * nodes changing colour 4x a second is the kind of thing that shows up in a profile.
 */
export function Waveform({ url, progress }: { url: string | null; progress: number }) {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const [peaks, setPeaks] = useState<Float32Array | null>(null)

	useEffect(() => {
		if (!url) {
			setPeaks(null)
			return
		}
		let cancelled = false
		getAudioPeaks(url).then((result) => {
			if (!cancelled) setPeaks(result)
		})
		return () => {
			cancelled = true
		}
	}, [url])

	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return
		const parent = canvas.parentElement
		if (!parent) return

		const draw = () => {
			const dpr = window.devicePixelRatio || 1
			const width = parent.clientWidth
			const height = parent.clientHeight
			if (!width || !height) return
			if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
				canvas.width = width * dpr
				canvas.height = height * dpr
			}
			const ctx = canvas.getContext('2d')
			if (!ctx) return
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
			ctx.clearRect(0, 0, width, height)

			const style = getComputedStyle(canvas)
			const playedColor = style.getPropertyValue('--waveform-played').trim() || '#0055ff'
			const restColor = style.getPropertyValue('--waveform-rest').trim() || '#c9c9c9'
			const playedX = width * Math.min(1, Math.max(0, progress))

			if (!peaks) {
				// No decoded audio (a video, or a file we couldn't read): a plain progress bar.
				const barHeight = 6
				const y = (height - barHeight) / 2
				ctx.fillStyle = restColor
				roundedRect(ctx, 0, y, width, barHeight, barHeight / 2)
				ctx.fill()
				ctx.fillStyle = playedColor
				roundedRect(ctx, 0, y, playedX, barHeight, barHeight / 2)
				ctx.fill()
				return
			}

			const gap = 1
			const barWidth = Math.max(1, width / WAVEFORM_BUCKETS - gap)
			for (let i = 0; i < peaks.length; i++) {
				const x = (i * width) / peaks.length
				// A floor, so silence still reads as a track rather than a gap in the control.
				const amplitude = Math.max(0.06, peaks[i])
				const barHeight = amplitude * height
				const y = (height - barHeight) / 2
				ctx.fillStyle = x + barWidth / 2 <= playedX ? playedColor : restColor
				roundedRect(ctx, x, y, barWidth, barHeight, Math.min(barWidth / 2, 1.5))
				ctx.fill()
			}
		}

		draw()
		const observer = new ResizeObserver(draw)
		observer.observe(parent)
		return () => observer.disconnect()
	}, [peaks, progress])

	return <canvas ref={canvasRef} className={styles.waveformCanvas} aria-hidden />
}

function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number
) {
	ctx.beginPath()
	if (w <= 0) return
	const radius = Math.min(r, w / 2, h / 2)
	ctx.moveTo(x + radius, y)
	ctx.arcTo(x + w, y, x + w, y + h, radius)
	ctx.arcTo(x + w, y + h, x, y + h, radius)
	ctx.arcTo(x, y + h, x, y, radius)
	ctx.arcTo(x, y, x + w, y, radius)
	ctx.closePath()
}
