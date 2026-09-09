import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runScheduledStorageGc } from './storageGcRunner'
import { Environment } from './types'

// Exercises the GC's real SQL. The unit tests in storageGc.test.ts cover the pass's shape with
// fakes; nothing there can catch a wrong column name or a join that silently matches nothing,
// and this runs on a cron, so a bad query would surface as storage that quietly never shrinks.
//
// Applies the shipped migration chain from zero-cache so the queries are checked against the
// schema that actually ships, not a hand-written copy of it. Opt-in on
// ZERO_CACHE_TEST_POSTGRES_URL, like the zero-cache suites (local dev stack:
// postgres://user:password@localhost:6543/postgres).
const CONNECTION_STRING = process.env.ZERO_CACHE_TEST_POSTGRES_URL

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../zero-cache/migrations')

const dbName = `tldraw_test_storage_gc_${process.pid}`

const describeMaybe = CONNECTION_STRING ? describe : describe.skip
if (!CONNECTION_STRING) {
	// eslint-disable-next-line no-console
	console.warn(
		'storageGcRunner.test.ts: skipping — set ZERO_CACHE_TEST_POSTGRES_URL to check the GC ' +
			'queries against a real postgres.'
	)
}

describeMaybe('runScheduledStorageGc', () => {
	let adminClient: pg.Client
	let client: pg.Client
	let env: Environment
	let deletedUploads: string[]

	beforeAll(async () => {
		adminClient = new pg.Client({ connectionString: CONNECTION_STRING })
		await adminClient.connect()
		await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`)
		await adminClient.query(`CREATE DATABASE "${dbName}"`)

		const url = new URL(CONNECTION_STRING!)
		url.pathname = `/${dbName}`
		client = new pg.Client({ connectionString: url.toString() })
		await client.connect()

		for (const filename of readdirSync(MIGRATIONS_DIR)
			.filter((f) => f.endsWith('.sql'))
			.sort()) {
			const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')
			try {
				await client.query(sql)
			} catch (err) {
				throw new Error(`Migration ${filename} failed: ${(err as Error).message}`)
			}
		}

		deletedUploads = []
		env = {
			BOTCOM_POSTGRES_POOLED_CONNECTION_STRING: url.toString(),
			MEASURE: undefined,
			UPLOADS: {
				delete: async (objectName: string) => {
					deletedUploads.push(objectName)
				},
			},
			TL_FILE_EFFECTS: {
				idFromName: () => '0',
				get: () => ({ poke: async () => {} }),
			},
		} as unknown as Environment
	})

	afterAll(async () => {
		if (client) await client.end()
		if (adminClient) {
			await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`)
			await adminClient.end()
		}
	})

	beforeEach(async () => {
		await client.query(
			`TRUNCATE "user", "file", "group", effect_outbox, deleted_entity, "asset" CASCADE`
		)
		deletedUploads.length = 0
	})

	async function seedUser(id: string) {
		await client.query(
			`INSERT INTO "user" ("id", "name", "email", "avatar", "color", "exportFormat", "exportTheme",
			   "exportBackground", "exportPadding", "createdAt", "updatedAt", "flags")
			 VALUES ($1, $1, $1, '', '', 'png', 'auto', false, false, 0, 0, '')`,
			[id]
		)
	}

	async function seedFile(id: string, owningGroupId: string | null = null) {
		await client.query(
			`INSERT INTO "file" ("id", "name", "ownerId", "owningGroupId", "thumbnail", "shared",
			   "sharedLinkType", "published", "lastPublished", "publishedSlug", "createdAt",
			   "updatedAt", "isEmpty")
			 VALUES ($1, $1, $2, $3, '', false, 'view', false, 0, $1, 0, 0, false)`,
			// file_owner_xor_check: a file is owned by a user or by a group, never both.
			[id, owningGroupId ? null : 'u1', owningGroupId]
		)
	}

	async function ageLedger(entityId: string, days: number) {
		await client.query(
			`UPDATE deleted_entity SET "deletedAt" = now() - ($2 || ' days')::interval
			 WHERE "entityId" = $1`,
			[entityId, days]
		)
	}

	const onError = vi.fn()

	it('leaves a board that is still inside its grace period', async () => {
		await seedUser('u1')
		await seedFile('f1')
		await client.query(`UPDATE "file" SET "isDeleted" = true WHERE id = 'f1'`)

		const result = await runScheduledStorageGc(env, { onError })

		expect(result.files).toBe(0)
		const rows = await client.query(`SELECT id FROM "file"`)
		expect(rows.rows).toEqual([{ id: 'f1' }])
	})

	it('purges a board past its grace period, with its uploads', async () => {
		await seedUser('u1')
		await seedFile('f1')
		await client.query(
			`INSERT INTO "asset" ("objectName", "fileId", "userId") VALUES ('o1', 'f1', 'u1')`
		)
		await client.query(`UPDATE "file" SET "isDeleted" = true WHERE id = 'f1'`)
		await ageLedger('f1', 30)

		const result = await runScheduledStorageGc(env, { onError })

		expect(result.files).toBe(1)
		expect(deletedUploads).toEqual(['o1'])
		expect((await client.query(`SELECT id FROM "file"`)).rows).toEqual([])
		// The file's DELETE clears its ledger row, so a second pass has nothing to redo.
		expect((await client.query(`SELECT count(*)::int AS n FROM deleted_entity`)).rows[0].n).toBe(0)
	})

	it('purges a workspace and its boards, boards first', async () => {
		await seedUser('u1')
		await client.query(`INSERT INTO "group" ("id", "name") VALUES ('g1', 'g1')`)
		await seedFile('f1', 'g1')
		await client.query(
			`INSERT INTO "asset" ("objectName", "fileId", "userId") VALUES ('o1', 'f1', 'u1')`
		)
		// Deleting the workspace soft-deletes its files through cleanup_deleted_group_trigger, so
		// both land in the ledger dated now.
		await client.query(`UPDATE "group" SET "isDeleted" = true WHERE id = 'g1'`)

		const result = await runScheduledStorageGc(env, { onError, trashRetentionDays: 0 })

		expect(result).toMatchObject({ files: 1, groups: 1 })
		expect((await client.query(`SELECT id FROM "group"`)).rows).toEqual([])
		expect((await client.query(`SELECT id FROM "file"`)).rows).toEqual([])
		// The group's row deletion cascades its files away in Postgres, which would take the asset
		// rows with them before anything read the object names. Purging the files first is what
		// keeps the upload from being stranded in R2.
		expect(deletedUploads).toEqual(['o1'])
	})

	it('leaves a workspace whose boards are still inside their own grace period', async () => {
		await seedUser('u1')
		await client.query(`INSERT INTO "group" ("id", "name") VALUES ('g1', 'g1')`)
		await seedFile('f1', 'g1')
		await client.query(`UPDATE "group" SET "isDeleted" = true WHERE id = 'g1'`)
		await ageLedger('g1', 30)

		const result = await runScheduledStorageGc(env, { onError })

		expect(result).toMatchObject({ files: 0, groups: 0 })
		expect((await client.query(`SELECT id FROM "group"`)).rows).toEqual([{ id: 'g1' }])
	})

	it('deletes an upload a board stopped referencing, and its row', async () => {
		await seedUser('u1')
		await seedFile('f1')
		await client.query(
			`INSERT INTO "asset" ("objectName", "fileId", "userId") VALUES ('o1', 'f1', 'u1')`
		)
		await client.query(
			`INSERT INTO asset_unreferenced ("objectName", "fileId", "since")
			 VALUES ('o1', 'f1', now() - interval '30 days')`
		)

		const result = await runScheduledStorageGc(env, { onError })

		expect(result.assets).toBe(1)
		expect(deletedUploads).toEqual(['o1'])
		expect((await client.query(`SELECT count(*)::int AS n FROM "asset"`)).rows[0].n).toBe(0)
		expect(
			(await client.query(`SELECT count(*)::int AS n FROM asset_unreferenced`)).rows[0].n
		).toBe(0)
	})

	it('leaves an upload the board only just stopped referencing', async () => {
		await seedUser('u1')
		await seedFile('f1')
		await client.query(
			`INSERT INTO "asset" ("objectName", "fileId", "userId") VALUES ('o1', 'f1', 'u1')`
		)
		await client.query(
			`INSERT INTO asset_unreferenced ("objectName", "fileId") VALUES ('o1', 'f1')`
		)

		const result = await runScheduledStorageGc(env, { onError })

		expect(result.assets).toBe(0)
		expect(deletedUploads).toEqual([])
	})
})
