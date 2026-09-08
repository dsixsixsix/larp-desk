import {
	AssetRecordType,
	TLAsset,
	TLBookmarkAsset,
	TLBookmarkShape,
	TLImageAsset,
	TLShapePartial,
	VecModel,
	createShapeId,
} from '@tldraw/editor'
import { createShapesForAssets } from '../lib/defaultExternalContentHandlers'
import { BookmarkShapeUtil } from '../lib/shapes/bookmark/BookmarkShapeUtil'
import { TestEditor } from './TestEditor'

const CARD_W = 220
const CARD_H = 96

/**
 * A bookmark asset carries no width of its own — the shape decides how big the card is. That is
 * the shape of the problem this file covers: an app with its own document or file asset type is in
 * exactly the same position.
 */
class BookmarkCardShapeUtil extends BookmarkShapeUtil {
	static override handledAssetTypes = ['bookmark'] as const

	override createShapeForAsset(asset: TLAsset, position: VecModel): TLShapePartial | null {
		if (asset.type !== 'bookmark') return null
		return {
			id: createShapeId(),
			type: 'bookmark',
			x: position.x,
			y: position.y,
			props: { assetId: asset.id, url: asset.props.src ?? '', w: CARD_W, h: CARD_H },
		} satisfies TLShapePartial<TLBookmarkShape>
	}
}

function bookmarkAsset(url: string): TLBookmarkAsset {
	return AssetRecordType.create({
		type: 'bookmark',
		props: { title: url, description: '', image: '', favicon: '', src: url },
		meta: {},
	}) as TLBookmarkAsset
}

function imageAsset(w: number, h: number): TLImageAsset {
	return AssetRecordType.create({
		type: 'image',
		props: {
			w,
			h,
			name: 'img.png',
			isAnimated: false,
			mimeType: 'image/png',
			src: 'data:ok',
			fileSize: 1,
		},
		meta: {},
	}) as TLImageAsset
}

let editor: TestEditor

beforeEach(() => {
	editor = new TestEditor({ shapeUtils: [BookmarkCardShapeUtil] })
})

afterEach(() => {
	editor?.dispose()
})

describe('createShapesForAssets', () => {
	it('lays assets without an intrinsic width out in a row rather than stacking them', async () => {
		const ids = await createShapesForAssets(
			editor,
			[
				bookmarkAsset('https://a.example'),
				bookmarkAsset('https://b.example'),
				bookmarkAsset('https://c.example'),
			],
			{ x: 0, y: 0 }
		)

		expect(ids).toHaveLength(3)
		const xs = ids.map((id) => editor.getShape(id)!.x)
		expect(new Set(xs).size).toBe(3)
		expect(xs[1] - xs[0]).toBe(CARD_W)
		expect(xs[2] - xs[1]).toBe(CARD_W)
	})

	it('keeps every shape on the same row', async () => {
		const ids = await createShapesForAssets(
			editor,
			[bookmarkAsset('https://a.example'), bookmarkAsset('https://b.example')],
			{ x: 0, y: 0 }
		)
		expect(ids).toHaveLength(2)
		const ys = ids.map((id) => editor.getShape(id)!.y)
		expect(ys[0]).toBe(ys[1])
	})

	it('still steps by the asset width when the asset has one', async () => {
		const ids = await createShapesForAssets(editor, [imageAsset(100, 50), imageAsset(300, 50)], {
			x: 0,
			y: 0,
		})
		expect(ids).toHaveLength(2)
		const xs = ids.map((id) => editor.getShape(id)!.x)
		expect(xs[1] - xs[0]).toBe(100)
	})

	it('mixes sized and unsized assets without overlap', async () => {
		const ids = await createShapesForAssets(
			editor,
			[imageAsset(100, 50), bookmarkAsset('https://a.example')],
			{ x: 0, y: 0 }
		)
		expect(ids).toHaveLength(2)
		const xs = ids.map((id) => editor.getShape(id)!.x)
		expect(xs[1] - xs[0]).toBe(100)
	})
})
