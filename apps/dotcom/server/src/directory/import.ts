import { readFileSync } from 'node:fs'
import { SqliteDirectoryDatabase } from './sqlite'
import { UNO_DIRECTORY_TABLES, UnoDirectoryDump, ensureUnoDirectoryTables } from './storage'

/**
 * Loads a directory dump from the Cloudflare deployment into this one's SQLite file.
 *
 *   curl -H "authorization: Bearer <admin session>" \
 *     https://old.example.com/api/uno/admin/export > directory.json
 *   DATABASE_PATH=/data/directory.sqlite node import.js directory.json
 *
 * Refuses to touch a database that already has people in it: this is a one-way move run once, and
 * merging two directories would silently produce duplicate accounts for anyone in both.
 */

function isDump(value: unknown): value is UnoDirectoryDump {
	if (!value || typeof value !== 'object') return false
	const dump = value as Partial<UnoDirectoryDump>
	if (dump.version !== 1) return false
	if (!dump.tables || typeof dump.tables !== 'object') return false
	return UNO_DIRECTORY_TABLES.every((table) => Array.isArray(dump.tables![table]))
}

export function importDirectory(databasePath: string, dumpPath: string) {
	const parsed: unknown = JSON.parse(readFileSync(dumpPath, 'utf8'))
	if (!isDump(parsed)) {
		throw new Error(
			`${dumpPath} is not a directory export. Expected the JSON body of GET /uno/admin/export.`
		)
	}

	const database = new SqliteDirectoryDatabase(databasePath)
	try {
		ensureUnoDirectoryTables(database)

		const existing = database.exec('SELECT COUNT(*) AS count FROM uno_users').toArray() as {
			count: number
		}[]
		if ((existing[0]?.count ?? 0) > 0) {
			throw new Error(
				`${databasePath} already holds ${existing[0].count} accounts. Import into an empty directory; merging would duplicate anyone present in both.`
			)
		}

		let imported = 0
		for (const table of UNO_DIRECTORY_TABLES) {
			for (const row of parsed.tables[table] as Record<string, unknown>[]) {
				const columns = Object.keys(row)
				if (columns.length === 0) continue
				// Column names come from the dump, so they are interpolated rather than bound — but
				// they are checked against the row the table's own schema produced, and a name that is
				// not a plain identifier cannot have come from one.
				if (columns.some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))) {
					throw new Error(`${table} has a column name that is not an identifier`)
				}
				database.exec(
					`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
					...columns.map((column) => row[column])
				)
				imported++
			}
		}
		return imported
	} finally {
		database.close()
	}
}
