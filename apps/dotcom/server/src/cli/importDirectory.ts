import { readConfig } from '../config'
import { importDirectory } from '../directory/import'

/**
 * Loads a directory export from the Cloudflare deployment. See the migration section of
 * DEPLOYMENT.md; run once, into an empty directory.
 */
const dumpPath = process.argv[2]
if (!dumpPath) {
	process.stderr.write('Usage: node import-directory.js <directory-export.json>\n')
	process.exit(1)
}

const { databasePath } = readConfig()
const imported = importDirectory(databasePath, dumpPath)
process.stdout.write(`Imported ${imported} rows into ${databasePath}\n`)
