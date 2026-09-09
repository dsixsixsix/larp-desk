import { sql } from 'kysely'
import {
	GC_ASSET_RETENTION_DAYS,
	GC_MAX_ASSETS_PER_RUN,
	GC_MAX_FILES_PER_RUN,
	GC_MAX_GROUPS_PER_RUN,
	GC_TRASH_RETENTION_DAYS,
} from './config'
import { hardDeleteAppFile } from './hardDeleteFile'
import { createPostgresConnectionPool } from './postgres'
import { StorageGcResult, runStorageGc } from './storageGc'
import { Environment } from './types'

function olderThan(days: number) {
	return sql<Date>`now() - (${days} || ' days')::interval`
}

/**
 * Wires one storage GC pass to Postgres and R2. Retention is overridable so an admin can drain
 * the pre-existing backlog (which migration 050 dates from its own deploy) without waiting out
 * a grace period the boards in it already served years ago.
 */
export async function runScheduledStorageGc(
	env: Environment,
	{
		trashRetentionDays = GC_TRASH_RETENTION_DAYS,
		assetRetentionDays = GC_ASSET_RETENTION_DAYS,
		onError,
	}: {
		trashRetentionDays?: number
		assetRetentionDays?: number
		onError(error: unknown, context: Record<string, unknown>): void
	}
): Promise<StorageGcResult> {
	const pg = createPostgresConnectionPool(env, 'storage-gc')
	try {
		return await runStorageGc(
			{
				listPurgeableFiles: (retentionDays, limit) =>
					pg
						.selectFrom('file')
						.innerJoin('deleted_entity', (join) =>
							join
								.onRef('deleted_entity.entityId', '=', 'file.id')
								.on('deleted_entity.tableName', '=', 'file')
						)
						.where('file.isDeleted', '=', true)
						.where('deleted_entity.deletedAt', '<', olderThan(retentionDays))
						.orderBy('deleted_entity.deletedAt')
						.limit(limit)
						.selectAll('file')
						.execute(),
				hardDeleteFile: (file) => hardDeleteAppFile({ pg, file, env }),
				listPurgeableGroups: async (retentionDays, limit) => {
					const rows = await pg
						.selectFrom('group')
						.innerJoin('deleted_entity', (join) =>
							join
								.onRef('deleted_entity.entityId', '=', 'group.id')
								.on('deleted_entity.tableName', '=', 'group')
						)
						.where('group.isDeleted', '=', true)
						.where('deleted_entity.deletedAt', '<', olderThan(retentionDays))
						// file.owningGroupId cascades on group delete, which would take the file rows
						// out from under the per-file upload cleanup. Wait for the files instead.
						.where(({ not, exists, selectFrom }) =>
							not(
								exists(
									selectFrom('file')
										.select('file.id')
										.whereRef('file.owningGroupId', '=', 'group.id')
								)
							)
						)
						.orderBy('deleted_entity.deletedAt')
						.limit(limit)
						.select('group.id')
						.execute()
					return rows.map((row) => row.id)
				},
				hardDeleteGroup: async (groupId) => {
					await pg.deleteFrom('group').where('id', '=', groupId).execute()
				},
				listPurgeableAssets: (retentionDays, limit) =>
					pg
						.selectFrom('asset_unreferenced')
						.where('since', '<', olderThan(retentionDays))
						.orderBy('since')
						.limit(limit)
						.select(['objectName', 'fileId'])
						.execute(),
				deleteUpload: (objectName) => env.UPLOADS.delete(objectName),
				deleteAssetRows: async (objectNames) => {
					// asset_unreferenced references asset ON DELETE CASCADE, so the markers go too.
					await pg.deleteFrom('asset').where('objectName', 'in', objectNames).execute()
				},
				onError,
			},
			{
				trashRetentionDays,
				assetRetentionDays,
				maxFiles: GC_MAX_FILES_PER_RUN,
				maxGroups: GC_MAX_GROUPS_PER_RUN,
				maxAssets: GC_MAX_ASSETS_PER_RUN,
			}
		)
	} finally {
		await pg.destroy()
	}
}
