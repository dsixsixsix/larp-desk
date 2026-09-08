import { TLAsset, TLVideoAsset } from 'tldraw'

/**
 * Audio rides on the `video` asset and shape types rather than getting types of its own.
 *
 * A new record type would have to be registered in the room schema on both the client and the
 * sync worker (see `fileSyncSchema` in TLFileDurableObject) and would land in every existing
 * document as an unknown type until both sides deploy. A `video` asset whose mimeType is an audio
 * type needs none of that and behaves identically everywhere else — same upload path, same asset
 * store, same arrow bindings. This module is the one place that distinction is drawn.
 */

/** Audio containers browsers can decode. Broader than the video list because audio is cheap. */
export const AUDIO_MIME_TYPES = [
	'audio/mpeg',
	'audio/mp3',
	'audio/mp4',
	'audio/x-m4a',
	'audio/aac',
	'audio/wav',
	'audio/x-wav',
	'audio/ogg',
	'audio/webm',
	'audio/flac',
] as const

/** The shape a dropped audio file gets: a player card, not a media frame with a real aspect ratio. */
export const AUDIO_CARD_W = 320
export const AUDIO_CARD_H = 88

export function isAudioMimeType(mimeType: string | null | undefined) {
	return !!mimeType?.startsWith('audio/')
}

export function isAudioAsset(asset: TLAsset | null | undefined): asset is TLVideoAsset {
	return asset?.type === 'video' && isAudioMimeType(asset.props.mimeType)
}

/** The file name to show on a card, falling back to something rather than an empty row. */
export function getMediaLabel(
	asset: { props: { name?: string } } | null | undefined,
	fallback: string
) {
	return asset?.props.name?.trim() || fallback
}

/** mm:ss, or h:mm:ss past an hour. Returns `--:--` until the media reports a duration. */
export function formatMediaTime(seconds: number | undefined) {
	if (seconds === undefined || !Number.isFinite(seconds)) return '--:--'
	const total = Math.max(0, Math.floor(seconds))
	const s = total % 60
	const m = Math.floor(total / 60) % 60
	const h = Math.floor(total / 3600)
	const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
	return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}
