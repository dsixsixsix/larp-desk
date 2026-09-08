import { ImageShapeUtil, TLImageShape } from 'tldraw'
import styles from './media.module.css'

/**
 * The image shape, taught to show its alt text as a visible caption.
 *
 * Core tldraw only ever uses `altText` for accessibility (the `<img alt>` attribute) — nothing
 * renders it on the canvas. Wrapping the original content in a positioned box and adding a label
 * above it is additive: the image itself is untouched, so cropping, resizing and export keep
 * working exactly as before.
 */
export class UnoImageShapeUtil extends ImageShapeUtil {
	override component(shape: TLImageShape) {
		const altText = shape.props.altText?.trim()

		return (
			<div style={{ position: 'relative', width: '100%', height: '100%' }}>
				{altText && (
					<div
						className={styles.imageAltLabel}
						aria-hidden
						// The label's font-size (and everything sized in em below it — padding,
						// radius, gap) is a fraction of the shape's own size, so it grows and
						// shrinks with the image on resize instead of staying pinned to a fixed
						// pixel size, matching the file card's scaling behaviour.
						style={{ fontSize: getAltLabelFontSize(shape) }}
					>
						{altText}
					</div>
				)}
				{super.component(shape)}
			</div>
		)
	}
}

function getAltLabelFontSize(shape: TLImageShape): number {
	const side = Math.min(shape.props.w, shape.props.h)
	return Math.max(10, Math.min(side * 0.07, 64))
}
