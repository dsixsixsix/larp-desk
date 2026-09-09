import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Focused integration test for the trash-ledger triggers (migration 050), which date every
// soft delete so sync-worker's scheduled storage GC can purge a board or workspace once its
// grace period is up. The design-critical case is the group cascade: deleting a workspace
// soft-deletes its files from inside cleanup_deleted_group_trigger (023_groups.sql), and the
// file ledger trigger has to fire for that plpgsql-driven UPDATE too — a trigger-on-trigger
// cascade only a real Postgres can exercise.
//
// Opt-in, and isolated the same way effect_outbox.test.ts is (a throwaway database, because
// the migration SQL hardcodes `public.`); see that file's header for the full reasoning.
const CONNECTION_STRING = process.env.ZERO_CACHE_TEST_POSTGRES_URL

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
	.filter((f) => f.endsWith('.sql'))
	.sort()

const dbName = `tldraw_test_trash_ledger_${process.pid}`

const describeMaybe = CONNECTION_STRING ? describe : describe.skip
if (!CONNECTION_STRING) {
	// eslint-disable-next-line no-console
	console.warn(
		'deleted_entity.test.ts: skipping — the storage GC decides what to purge from this ledger; ' +
			'set ZERO_CACHE_TEST_POSTGRES_URL to verify it against a real postgres.'
	)
}

describeMaybe('trash ledger triggers (soft delete, restore, group cascade)', () => {
	let adminClient: pg.Client
	let client: pg.Client

	beforeAll(async () => {
		adminClient = new pg.Client({ connectionString: CONNECTION_STRING })
		await adminClient.connect()
		await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`)
		await adminClient.query(`CREATE DATABASE "${dbName}"`)

		const url = new URL(CONNECTION_STRING!)
		url.pathname = `/${dbName}`
		client = new pg.Client({ connectionString: url.toString() })
		await client.connect()

		for (const filename of MIGRATION_FILES) {
			const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')
			try {
				await client.query(sql)
			} catch (err) {
				throw new Error(`Migration ${filename} failed: ${(err as Error).message}`)
			}
		}
	})

	afterAll(async () => {
		if (client) await client.end()
		if (adminClient) {
			await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`)
			await adminClient.end()
		}
	})

	beforeEach(async () => {
		await client.query(`TRUNCATE "user", "file", "group", effect_outbox, deleted_entity CASCADE`)
	})

	async function seedUser(id: string) {
		await client.query(
			`INSERT INTO "user" ("id", "name", "email", "avatar", "color", "exportFormat", "exportTheme",
			   "exportBackground", "exportPadding", "createdAt", "updatedAt", "flags")
			 VALUES ($1, $1, $1, '', '', 'png', 'auto', false, false, 0, 0, '')`,
			[id]
		)
	}

	async function seedGroup(id: string) {
		await client.query(`INSERT INTO "group" ("id", "name") VALUES ($1, $1)`, [id])
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

	async function ledger(): Promise<Array<{ tableName: string; entityId: string }>> {
		const res = await client.query(
			`SELECT "tableName", "entityId" FROM deleted_entity ORDER BY "tableName", "entityId"`
		)
		return res.rows
	}

	it('records nothing for a file that is created and never deleted', async () => {
		await seedUser('u1')
		await seedFile('f1')
		expect(await ledger()).toEqual([])
	})

	it('records a file when it is soft-deleted, and clears it when restored', async () => {
		await seedUser('u1')
		await seedFile('f1')

		await client.query(`UPDATE "file" SET "isDeleted" = true WHERE id = 'f1'`)
		expect(await ledger()).toEqual([{ tableName: 'file', entityId: 'f1' }])

		await client.query(`UPDATE "file" SET "isDeleted" = false WHERE id = 'f1'`)
		expect(await ledger()).toEqual([])
	})

	it('keeps the original date when a file is re-marked deleted', async () => {
		await seedUser('u1')
		await seedFile('f1')
		await client.query(`UPDATE "file" SET "isDeleted" = true WHERE id = 'f1'`)
		const first = await client.query(`SELECT "deletedAt" FROM deleted_entity`)

		// An idempotent re-delete (an admin hard delete soft-deletes first) must not push the
		// purge deadline out.
		await client.query(`UPDATE "file" SET "isDeleted" = true WHERE id = 'f1'`)
		const second = await client.query(`SELECT "deletedAt" FROM deleted_entity`)

		expect(second.rows[0].deletedAt).toEqual(first.rows[0].deletedAt)
	})

	it('clears a file ledger row when the file is hard-deleted', async () => {
		await seedUser('u1')
		await seedFile('f1')
		await client.query(`UPDATE "file" SET "isDeleted" = true WHERE id = 'f1'`)
		await client.query(`DELETE FROM "file" WHERE id = 'f1'`)
		expect(await ledger()).toEqual([])
	})

	it('records the group and every file it owns when a workspace is deleted', async () => {
		await seedUser('u1')
		await seedGroup('g1')
		await seedFile('f1', 'g1')
		await seedFile('f2', 'g1')

		// cleanup_deleted_group_trigger soft-deletes the group's files from inside plpgsql;
		// the file ledger trigger has to fire for those UPDATEs too.
		await client.query(`UPDATE "group" SET "isDeleted" = true WHERE id = 'g1'`)

		expect(await ledger()).toEqual([
			{ tableName: 'file', entityId: 'f1' },
			{ tableName: 'file', entityId: 'f2' },
			{ tableName: 'group', entityId: 'g1' },
		])
	})

	it('clears the ledger for a group and its cascaded files when the group is hard-deleted', async () => {
		await seedUser('u1')
		await seedGroup('g1')
		await seedFile('f1', 'g1')
		await client.query(`UPDATE "group" SET "isDeleted" = true WHERE id = 'g1'`)

		// file.owningGroupId cascades, so this deletes f1 too.
		await client.query(`DELETE FROM "group" WHERE id = 'g1'`)

		expect(await ledger()).toEqual([])
	})

	it('cascades asset_unreferenced markers away with the asset row', async () => {
		await seedUser('u1')
		await seedFile('f1')
		await client.query(
			`INSERT INTO "asset" ("objectName", "fileId", "userId") VALUES ('o1', 'f1', 'u1')`
		)
		await client.query(
			`INSERT INTO asset_unreferenced ("objectName", "fileId") VALUES ('o1', 'f1')`
		)

		await client.query(`DELETE FROM "asset" WHERE "objectName" = 'o1'`)

		const res = await client.query(`SELECT count(*)::int AS n FROM asset_unreferenced`)
		expect(res.rows[0].n).toBe(0)
	})
})
