import {
	AssetUtil,
	T,
	TLAssetId,
	TLBaseAsset,
	createAssetPropsMigrationIds,
	createAssetPropsMigrationSequence,
} from 'tldraw'
import { FILE_CARD_MIME_TYPES } from './file-shared'

export const BOARD_FILE_ASSET_TYPE = 'board-file' as const

export interface TLBoardFileAssetProps {
	name: string
	size: number
	mimeType: string | null
	src: string | null
	description: string | null
}

export type TLBoardFileAsset = TLBaseAsset<typeof BOARD_FILE_ASSET_TYPE, TLBoardFileAssetProps>

declare module 'tldraw' {
	interface TLGlobalAssetPropsMap {
		[BOARD_FILE_ASSET_TYPE]: TLBoardFileAssetProps
	}
}

const Versions = createAssetPropsMigrationIds(BOARD_FILE_ASSET_TYPE, {
	AddDescription: 1,
})

/** Backfills `description` on file-card assets stored before that field existed. */
const fileAssetMigrations = createAssetPropsMigrationSequence({
	sequence: [
		{
			id: Versions.AddDescription,
			up: (props) => {
				props.description = null
			},
			down: (props) => {
				delete props.description
			},
		},
	],
})

/**
 * Accepts non-media files (.md, .txt, .json, .pdf, .docx, .xlsx) that the SDK's built-in image,
 * video and bookmark asset types don't cover, and turns them into a downloadable card. Paired
 * with FileCardShapeUtil, which renders the card and is what `handledAssetTypes` connects to.
 */
export class FileAssetUtil extends AssetUtil<TLBoardFileAsset> {
	static override type = BOARD_FILE_ASSET_TYPE

	static override props = {
		name: T.string,
		size: T.number,
		mimeType: T.string.nullable(),
		src: T.string.nullable(),
		description: T.string.nullable(),
	}

	static override migrations = fileAssetMigrations

	override getDefaultProps(): TLBoardFileAsset['props'] {
		return { name: '', size: 0, mimeType: '', src: null, description: null }
	}

	override getSupportedMimeTypes(): readonly string[] {
		return Object.keys(FILE_CARD_MIME_TYPES)
	}

	override async getAssetFromFile(file: File, assetId: TLAssetId): Promise<TLBoardFileAsset> {
		return {
			id: assetId,
			type: BOARD_FILE_ASSET_TYPE,
			typeName: 'asset',
			props: {
				name: file.name,
				size: file.size,
				mimeType: file.type,
				// Filled in by the asset store's `upload` once the file is stored.
				src: null,
				description: null,
			},
			meta: {},
		}
	}
}
