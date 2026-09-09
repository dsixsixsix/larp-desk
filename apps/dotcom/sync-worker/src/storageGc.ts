import { TlaFile } from '@tldraw/dotcom-shared'

export interface StorageGcOptions {
	/** How long a soft-deleted board or workspace stays restorable before it is purged. */
	trashRetentionDays: number
	/** How long an upload stays in R2 after the board stopped referencing it. */
	assetRetentionDays: number
	maxFiles: number
	maxGroups: number
	maxAssets: number
}

export interface UnreferencedAsset {
	objectName: string
	fileId: string
}

export interface StorageGcDeps {
	/** Soft-deleted files whose grace period has elapsed, oldest first. */
	listPurgeableFiles(retentionDays: number, limit: number): Promise<TlaFile[]>
	/** Removes the file's uploads, its row, and (via the outbox) its R2 objects and DO state. */
	hardDeleteFile(file: TlaFile): Promise<void>
	/**
	 * Soft-deleted groups whose grace period has elapsed AND which own no file rows. Deleting a
	 * group cascades its files away in Postgres, which would skip the per-file upload cleanup,
	 * so a group is only purged once its files already are.
	 */
	listPurgeableGroups(retentionDays: number, limit: number): Promise<string[]>
	hardDeleteGroup(groupId: string): Promise<void>
	listPurgeableAssets(retentionDays: number, limit: number): Promise<UnreferencedAsset[]>
	deleteUpload(objectName: string): Promise<void>
	deleteAssetRows(objectNames: string[]): Promise<void>
	onError(error: unknown, context: Record<string, unknown>): void
}

export interface StorageGcResult {
	files: number
	groups: number
	assets: number
	failures: number
}

/**
 * One pass of the scheduled storage GC.
 *
 * Everything is batched and per-item guarded: a pass runs inside a worker's CPU and subrequest
 * budget, and one board whose cleanup fails must not stop the rest of the backlog. Whatever a
 * pass doesn't get to stays in the ledger for the next one, so a large backlog drains over
 * several passes rather than in one long-running invocation.
 *
 * Order matters: files, then the groups they belonged to (see `listPurgeableGroups`), then
 * uploads. A purged file's assets are deleted by `hardDeleteFile` and their ledger rows cascade
 * away, so the asset stage only ever sees uploads dropped from boards that still exist.
 */
export async function runStorageGc(
	deps: StorageGcDeps,
	opts: StorageGcOptions
): Promise<StorageGcResult> {
	const result: StorageGcResult = { files: 0, groups: 0, assets: 0, failures: 0 }

	const files = await deps.listPurgeableFiles(opts.trashRetentionDays, opts.maxFiles)
	for (const file of files) {
		try {
			await deps.hardDeleteFile(file)
			result.files++
		} catch (e) {
			result.failures++
			deps.onError(e, { stage: 'file', fileId: file.id })
		}
	}

	const groups = await deps.listPurgeableGroups(opts.trashRetentionDays, opts.maxGroups)
	for (const groupId of groups) {
		try {
			await deps.hardDeleteGroup(groupId)
			result.groups++
		} catch (e) {
			result.failures++
			deps.onError(e, { stage: 'group', groupId })
		}
	}

	const assets = await deps.listPurgeableAssets(opts.assetRetentionDays, opts.maxAssets)
	const deletedObjectNames: string[] = []
	for (const asset of assets) {
		try {
			await deps.deleteUpload(asset.objectName)
			deletedObjectNames.push(asset.objectName)
		} catch (e) {
			// The row stays, so the next pass retries this object. Dropping the row on a failed
			// R2 delete would strand the object with nothing left pointing at it.
			result.failures++
			deps.onError(e, { stage: 'asset', objectName: asset.objectName, fileId: asset.fileId })
		}
	}
	if (deletedObjectNames.length > 0) {
		try {
			await deps.deleteAssetRows(deletedObjectNames)
			result.assets = deletedObjectNames.length
		} catch (e) {
			// The objects are gone but their rows survive, so the next pass re-deletes objects
			// that no longer exist. R2 deletes are idempotent, so that costs a call, not data.
			result.failures++
			deps.onError(e, { stage: 'asset_rows', count: deletedObjectNames.length })
		}
	}

	return result
}

/**
 * Splits a board's asset rows into the ones its document still points at and the ones it
 * doesn't, given the set of object names referenced by the current snapshot.
 *
 * Kept separate from the marking query so the room DO can skip both writes when nothing moved:
 * an unchanged asset set is the normal case on a persist.
 */
export function diffReferencedAssets(
	rows: Iterable<{ objectName: string }>,
	referencedObjectNames: ReadonlySet<string>
): { referenced: string[]; unreferenced: string[] } {
	const referenced: string[] = []
	const unreferenced: string[] = []
	for (const row of rows) {
		if (referencedObjectNames.has(row.objectName)) {
			referenced.push(row.objectName)
		} else {
			unreferenced.push(row.objectName)
		}
	}
	return { referenced, unreferenced }
}
