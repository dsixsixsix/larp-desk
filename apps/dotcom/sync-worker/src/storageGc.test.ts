import { TlaFile } from '@tldraw/dotcom-shared'
import { describe, expect, it, vi } from 'vitest'
import { StorageGcDeps, StorageGcOptions, diffReferencedAssets, runStorageGc } from './storageGc'

function file(id: string): TlaFile {
	return {
		id,
		name: 'file',
		ownerName: '',
		thumbnail: '',
		shared: true,
		sharedLinkType: 'edit',
		published: false,
		lastPublished: 0,
		publishedSlug: `slug-${id}`,
		createdAt: 0,
		updatedAt: 0,
		isEmpty: false,
		isDeleted: true,
		createSource: null,
		owningGroupId: null,
	}
}

const options: StorageGcOptions = {
	trashRetentionDays: 7,
	assetRetentionDays: 7,
	maxFiles: 10,
	maxGroups: 10,
	maxAssets: 10,
}

function deps(overrides: Partial<StorageGcDeps> = {}) {
	return {
		listPurgeableFiles: vi.fn().mockResolvedValue([]),
		hardDeleteFile: vi.fn().mockResolvedValue(undefined),
		listPurgeableGroups: vi.fn().mockResolvedValue([]),
		hardDeleteGroup: vi.fn().mockResolvedValue(undefined),
		listPurgeableAssets: vi.fn().mockResolvedValue([]),
		deleteUpload: vi.fn().mockResolvedValue(undefined),
		deleteAssetRows: vi.fn().mockResolvedValue(undefined),
		onError: vi.fn(),
		...overrides,
	} satisfies StorageGcDeps
}

describe('runStorageGc', () => {
	it('purges files, then groups, then uploads', async () => {
		const order: string[] = []
		const d = deps({
			listPurgeableFiles: vi.fn().mockResolvedValue([file('f1'), file('f2')]),
			hardDeleteFile: vi.fn(async (f: TlaFile) => {
				order.push(`file:${f.id}`)
			}),
			listPurgeableGroups: vi.fn().mockResolvedValue(['g1']),
			hardDeleteGroup: vi.fn(async (id: string) => {
				order.push(`group:${id}`)
			}),
			listPurgeableAssets: vi.fn().mockResolvedValue([{ objectName: 'a1', fileId: 'f3' }]),
			deleteUpload: vi.fn(async (name: string) => {
				order.push(`upload:${name}`)
			}),
		})

		const result = await runStorageGc(d, options)

		expect(result).toEqual({ files: 2, groups: 1, assets: 1, failures: 0 })
		expect(order).toEqual(['file:f1', 'file:f2', 'group:g1', 'upload:a1'])
		expect(d.deleteAssetRows).toHaveBeenCalledWith(['a1'])
	})

	it('passes the configured retentions and caps to the queries', async () => {
		const d = deps()
		await runStorageGc(d, {
			trashRetentionDays: 30,
			assetRetentionDays: 3,
			maxFiles: 5,
			maxGroups: 6,
			maxAssets: 7,
		})
		expect(d.listPurgeableFiles).toHaveBeenCalledWith(30, 5)
		expect(d.listPurgeableGroups).toHaveBeenCalledWith(30, 6)
		expect(d.listPurgeableAssets).toHaveBeenCalledWith(3, 7)
	})

	it('keeps going when one file fails, and reports it', async () => {
		const error = new Error('r2 down')
		const d = deps({
			listPurgeableFiles: vi.fn().mockResolvedValue([file('f1'), file('f2')]),
			hardDeleteFile: vi.fn(async (f: TlaFile) => {
				if (f.id === 'f1') throw error
			}),
		})

		const result = await runStorageGc(d, options)

		expect(result).toEqual({ files: 1, groups: 0, assets: 0, failures: 1 })
		expect(d.onError).toHaveBeenCalledWith(error, { stage: 'file', fileId: 'f1' })
	})

	it('keeps the row of an upload whose R2 delete failed, so the next pass retries it', async () => {
		const d = deps({
			listPurgeableAssets: vi.fn().mockResolvedValue([
				{ objectName: 'a1', fileId: 'f1' },
				{ objectName: 'a2', fileId: 'f1' },
			]),
			deleteUpload: vi.fn(async (name: string) => {
				if (name === 'a1') throw new Error('nope')
			}),
		})

		const result = await runStorageGc(d, options)

		expect(result).toEqual({ files: 0, groups: 0, assets: 1, failures: 1 })
		expect(d.deleteAssetRows).toHaveBeenCalledWith(['a2'])
	})

	it('does not delete asset rows when nothing was deleted from R2', async () => {
		const d = deps({
			listPurgeableAssets: vi.fn().mockResolvedValue([{ objectName: 'a1', fileId: 'f1' }]),
			deleteUpload: vi.fn().mockRejectedValue(new Error('nope')),
		})

		const result = await runStorageGc(d, options)

		expect(result.assets).toBe(0)
		expect(d.deleteAssetRows).not.toHaveBeenCalled()
	})
})

describe('diffReferencedAssets', () => {
	it('splits rows by whether the document still points at them', () => {
		expect(
			diffReferencedAssets(
				[{ objectName: 'a' }, { objectName: 'b' }, { objectName: 'c' }],
				new Set(['a', 'c'])
			)
		).toEqual({ referenced: ['a', 'c'], unreferenced: ['b'] })
	})

	it('treats a document referencing objects with no rows as nothing to mark', () => {
		expect(diffReferencedAssets([], new Set(['a']))).toEqual({
			referenced: [],
			unreferenced: [],
		})
	})
})
