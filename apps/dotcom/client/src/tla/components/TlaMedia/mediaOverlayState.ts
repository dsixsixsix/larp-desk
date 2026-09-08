import { TLShapeId, atom } from 'tldraw'

/**
 * Which media shape currently has its player open, or null.
 *
 * One at a time by construction: opening a second card closes the first, so two tracks can never
 * play over each other. Module-scoped because a page only ever mounts one canvas.
 */
const openMediaShapeId = atom<TLShapeId | null>('openMediaShapeId', null)

export function getOpenMediaShapeId() {
	return openMediaShapeId
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
