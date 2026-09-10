import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { UnoDirectorySql } from './storage'

/**
 * `UnoDirectorySql` backed by Node's own SQLite.
 *
 * This is the whole of what replaced Durable Object storage: the statements in `storage.ts` are
 * unchanged from the Cloudflare version, because that file was already written against this
 * one-method interface. `node:sqlite` rather than a native module so the image needs no build
 * toolchain and no install-script allowlist entry.
 *
 * Node 24 is required: `node:sqlite` is behind `--experimental-sqlite` on Node 22.
 */
export class SqliteDirectoryDatabase implements UnoDirectorySql {
	private readonly db: DatabaseSync
	/**
	 * Statements are reused rather than re-prepared. Every directory read runs several of them, and
	 * the set is closed — the queries are literals in `storage.ts`, so this cannot grow unbounded.
	 */
	private readonly statements = new Map<string, StatementSync>()

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
		this.db = new DatabaseSync(path)
		// WAL survives a hard stop with the database intact, which matters when the container can be
		// killed at any point, and lets a read run while a write is in flight.
		this.db.exec('PRAGMA journal_mode = WAL')
		// FULL would fsync on every statement; NORMAL loses at most the last transaction to a power
		// cut, which for an invite list is the right trade against a write per keystroke.
		this.db.exec('PRAGMA synchronous = NORMAL')
		this.db.exec('PRAGMA busy_timeout = 5000')
	}

	exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } {
		let statement = this.statements.get(query)
		if (!statement) {
			statement = this.db.prepare(query)
			this.statements.set(query, statement)
		}
		// `all` on a statement that returns nothing gives an empty array, so reads and writes go
		// through the same call and no query has to be classified.
		const result = statement.all(...(bindings as never[]))
		return { toArray: () => result }
	}

	close() {
		this.statements.clear()
		this.db.close()
	}
}
