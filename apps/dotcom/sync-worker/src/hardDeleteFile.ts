import { DB, TlaFile } from '@tldraw/dotcom-shared'
import { Kysely } from 'kysely'
import { Environment } from './types'
import { getFileEffectProcessor } from './utils/durableObjects'

/**
 * Removes a file for good: its uploads, its row, and — through the delete row the outbox
 * trigger writes — its R2 objects and durable object state.
 *
 * Everything except the uploads rides that terminal effect
 * (`TLFileDurableObject.appFileRecordDidDelete`). The uploads can't: `DELETE FROM file`
 * cascades the asset rows away, so the object names have to be read and deleted first or
 * they are lost, and the objects stay in R2 with nothing left pointing at them.
 */
export async function hardDeleteAppFile({
	pg,
	file,
	env,
}: {
	env: Environment
	pg: Kysely<DB>
	file: TlaFile
}) {
	if (!file.isDeleted) {
		// do soft delete first if not done already; the outbox trigger records it
		await pg.updateTable('file').set('isDeleted', true).where('id', '=', file.id).execute()
	}
	// Session kicks and R2/room cleanup ride the terminal delete-row effect written by the
	// DELETE FROM file below, delivered via the post-delete poke() (sweep backstop ~30s); the
	// soft-delete row's effect is staleness-guarded, so it skips harmlessly if it runs after
	// the row is gone.
	// clean up assets eagerly
	const assets = await pg.selectFrom('asset').where('fileId', '=', file.id).selectAll().execute()
	for (const asset of assets) {
		await env.UPLOADS.delete(asset.objectName)
		// TODO: bust caches
		// it's tricky though. calling caches.default.delete() will only delete the cache entry
		// in the local datacenter so we'd need to do a global cache bust with the REST API
		// either that or maintain a KV store of deleted assets and check that before serving
		// could maybe use a bloom filter if that hurts perf too much.
		// although how would the bloom filter sync across workers 🤔
		// since cache entries last a year we could store a timestamp in the KV and clean it periodically
		// or just let it grow forever, it's not that big.

		// const cacheUrl = new URL(`${appOrigin}/app/uploads/${asset.objectName}`)
		// console.log('Busting our cache entry', asset.objectName)
		// await caches.default.delete(cacheUrl)
		// console.log('Busting resize worker cache entry')
		// await env.IMAGE_RESIZE_WORKER.bustCache(cacheUrl.toString())
	}
	// hard delete file (this will trigger a cascade delete of all remaining related records & R2 objects)
	await pg.deleteFrom('file').where('id', '=', file.id).execute()
	// Nudge the outbox so the delete's effects land promptly instead of waiting for the 30s
	// alarm sweep. poke() is cheap: it just schedules an alarm. Best-effort nudge: the sweep
	// backstops it, so a poke failure must not fail the caller after the delete committed.
	await getFileEffectProcessor(env)
		.poke()
		.catch(() => {})
}
