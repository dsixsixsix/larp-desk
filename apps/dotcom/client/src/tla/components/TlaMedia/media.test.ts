import { AssetRecordType, Editor, TLVideoAsset } from 'tldraw'
import { describe, expect, it } from 'vitest'
import {
	AUDIO_CARD_H,
	AUDIO_CARD_W,
	formatMediaTime,
	getMediaLabel,
	isAudioAsset,
} from './media-shared'
import { UnoMediaAssetUtil } from './UnoMediaAssetUtil'

function videoAsset(props: Partial<TLVideoAsset['props']>): TLVideoAsset {
	return {
		id: AssetRecordType.createId('test'),
		typeName: 'asset',
		type: 'video',
		meta: {},
		props: {
			name: 'clip.mp4',
			src: 'https://example.com/clip.mp4',
			w: 100,
			h: 100,
			mimeType: 'video/mp4',
			isAnimated: true,
			...props,
		},
	}
}

describe('isAudioAsset', () => {
	it('is true for a video asset carrying an audio mime type', () => {
		expect(isAudioAsset(videoAsset({ mimeType: 'audio/mpeg' }))).toBe(true)
	})

	it('is false for video, for a missing mime type, and for nothing at all', () => {
		expect(isAudioAsset(videoAsset({ mimeType: 'video/mp4' }))).toBe(false)
		expect(isAudioAsset(videoAsset({ mimeType: null }))).toBe(false)
		expect(isAudioAsset(null)).toBe(false)
	})
})

describe('formatMediaTime', () => {
	it('formats under, over, and across an hour', () => {
		expect(formatMediaTime(0)).toBe('0:00')
		expect(formatMediaTime(9)).toBe('0:09')
		expect(formatMediaTime(75)).toBe('1:15')
		expect(formatMediaTime(3725)).toBe('1:02:05')
	})

	it('shows a placeholder until the media reports a duration', () => {
		expect(formatMediaTime(undefined)).toBe('--:--')
		expect(formatMediaTime(NaN)).toBe('--:--')
		expect(formatMediaTime(Infinity)).toBe('--:--')
	})
})

describe('getMediaLabel', () => {
	it('falls back when the asset has no usable name', () => {
		expect(getMediaLabel(videoAsset({ name: 'song.mp3' }), 'Audio')).toBe('song.mp3')
		expect(getMediaLabel(videoAsset({ name: '   ' }), 'Audio')).toBe('Audio')
		expect(getMediaLabel(null, 'Audio')).toBe('Audio')
	})
})

describe('UnoMediaAssetUtil', () => {
	// The util reaches for the editor only on the video path, which this suite doesn't take.
	const util = new UnoMediaAssetUtil(null as unknown as Editor)

	it('accepts audio mime types alongside the video ones', () => {
		const supported = util.getSupportedMimeTypes()
		expect(supported).toContain('video/mp4')
		expect(supported).toContain('audio/mpeg')
		expect(supported).toContain('audio/wav')
	})

	it('gives an audio file the card size instead of probing it for dimensions', async () => {
		const file = new File(['test'], 'song.mp3', { type: 'audio/mpeg' })
		const asset = await util.getAssetFromFile(file, AssetRecordType.createId('song'))

		expect(asset).toEqual({
			id: AssetRecordType.createId('song'),
			type: 'video',
			typeName: 'asset',
			meta: {},
			props: {
				name: 'song.mp3',
				src: '',
				w: AUDIO_CARD_W,
				h: AUDIO_CARD_H,
				fileSize: file.size,
				mimeType: 'audio/mpeg',
				isAnimated: false,
			},
		})
	})
})
