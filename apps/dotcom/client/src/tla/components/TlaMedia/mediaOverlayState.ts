import { TLShapeId, atom } from 'tldraw'

/**
 * Which media shape currently has its player open, or null.
 *
 * One at a time by construction: opening a second card closes the first, so two tracks can never
 * play over each other. Module-scoped because a page only ever mounts one canvas.
 */
const openMediaShapeId = atom<TLShapeId | null>('openMediaShapeId', null)

/** Whether the open player is playing, published so the card's own button can show pause. */
const openMediaIsPlaying = atom<boolean>('openMediaIsPlaying', false)

/**
 * The open player's play/pause, lent out to the card on the canvas.
 *
 * The two buttons have to be one control. Before this, the card's button reopened the player, and
 * because the click first landed on the canvas — which dismisses the player — that meant closing
 * and remounting it, so the track restarted from zero instead of pausing.
 */
let togglePlayback: (() => void) | null = null

export function getOpenMediaShapeId() {
	return openMediaShapeId
}

export function getOpenMediaIsPlaying() {
	return openMediaIsPlaying
}

export function openMediaPlayer(shapeId: TLShapeId) {
	openMediaShapeId.set(shapeId)
}

export function closeMediaPlayer() {
	openMediaShapeId.set(null)
}

/** Closes the player if it is the given shape's — used when a shape is deleted or the file changes. */
export function closeMediaPlayerFor(shapeId: TLShapeId) {
	if (openMediaShapeId.get() === shapeId) openMediaShapeId.set(null)
}

export function setOpenMediaIsPlaying(isPlaying: boolean) {
	openMediaIsPlaying.set(isPlaying)
}

/** Called by the player on mount. Returns the teardown, which also clears the playing flag. */
export function registerMediaPlayback(toggle: () => void) {
	togglePlayback = toggle
	return () => {
		if (togglePlayback !== toggle) return
		togglePlayback = null
		openMediaIsPlaying.set(false)
	}
}

export function toggleOpenMediaPlayback() {
	togglePlayback?.()
}
