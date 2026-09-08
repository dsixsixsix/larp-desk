import { DEFAULT_SUPPORT_VIDEO_TYPES, TLAssetId, TLVideoAsset, VideoAssetUtil } from 'tldraw'
import { AUDIO_CARD_H, AUDIO_CARD_W, AUDIO_MIME_TYPES, isAudioMimeType } from './media-shared'

/**
 * The video asset util, widened to accept audio files.
 *
 * Registering audio mime types here is what lets a dropped mp3 through at all: the drop handler
 * asks the editor for an asset util that claims the file's mime type and rejects the file when
 * none does. See {@link isAudioAsset} for why audio is a video asset rather than its own type.
 */
export class UnoMediaAssetUtil extends VideoAssetUtil {
	override getSupportedMimeTypes(): readonly string[] {
		return [
			...(this.options.supportedMimeTypes ?? DEFAULT_SUPPORT_VIDEO_TYPES),
			...AUDIO_MIME_TYPES,
		]
	}

	override async getAssetFromFile(file: File, assetId: TLAssetId): Promise<TLVideoAsset | null> {
		if (!isAudioMimeType(file.type)) return super.getAssetFromFile(file, assetId)

		// Audio has no intrinsic size to probe — `getVideoSize` would wait on dimensions that never
		// arrive — so the card size is the asset size.
		return {
			id: assetId,
			type: 'video',
			typeName: 'asset',
			props: {
				name: file.name,
				src: '',
				w: AUDIO_CARD_W,
				h: AUDIO_CARD_H,
				fileSize: file.size,
				mimeType: file.type,
				isAnimated: false,
			},
			meta: {},
		}
	}
}
