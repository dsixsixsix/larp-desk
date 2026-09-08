import { EmbedShapeUtil } from 'tldraw'
import { FileAssetUtil } from '../tla/components/TlaFile/FileAssetUtil'
import { FileCardShapeUtil } from '../tla/components/TlaFile/FileCardShapeUtil'
import { UnoImageShapeUtil } from '../tla/components/TlaMedia/UnoImageShapeUtil'
import { UnoMediaAssetUtil } from '../tla/components/TlaMedia/UnoMediaAssetUtil'
import { UnoMediaShapeUtil } from '../tla/components/TlaMedia/UnoMediaShapeUtil'

// vite inlines this NEXT_PUBLIC_ var at build time.
const googleMapsApiKey = process.env.NEXT_PUBLIC_GC_API_KEY

// Module-scoped so the arrays keep a stable identity across renders.

/**
 * The embed and media entries replace an SDK default of the same type (`<Tldraw>` merges by
 * type), so the room schema is unchanged for those. FileCardShapeUtil is a genuinely new type —
 * fine here because the local scratch canvas (the only place this is used) isn't a synced room.
 */
export const embedShapeUtils = [
	EmbedShapeUtil.configure({ embedConfig: { google_maps: { apiKey: googleMapsApiKey } } }),
	UnoMediaShapeUtil,
	UnoImageShapeUtil,
	FileCardShapeUtil,
]

/** Widens the video asset util to accept audio files. See UnoMediaAssetUtil. */
export const unoAssetUtils = [UnoMediaAssetUtil, FileAssetUtil]
