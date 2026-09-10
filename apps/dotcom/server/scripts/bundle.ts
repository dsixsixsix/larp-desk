import { build } from 'esbuild'

/**
 * Bundles the server into one file for the runtime image.
 *
 * Without this the image would need the whole monorepo — TypeScript, the workspace links, a
 * loader — to start one process. Bundling turns it into `node index.js` on a base image with
 * nothing installed, which is also what keeps the container's attack surface to the Node binary.
 *
 * `node:sqlite` is a builtin and stays external, as every `node:` import does under
 * `platform: 'node'`.
 */
await build({
	// The server, plus the one-shot migration command — bundled together so the image can run the
	// import without the repository.
	entryPoints: { index: 'src/index.ts', 'import-directory': 'src/cli/importDirectory.ts' },
	outdir: 'dist',
	bundle: true,
	platform: 'node',
	// The runtime image pins Node 24, which is also the floor for unflagged node:sqlite.
	target: 'node24',
	format: 'esm',
	sourcemap: true,
	minify: false,
	// esbuild's ESM output has no `require`, which some transitive CommonJS dependencies still
	// reach for. This gives them one built from the bundle's own URL.
	banner: {
		js: [
			"import { createRequire as __createRequire } from 'node:module'",
			'const require = __createRequire(import.meta.url)',
		].join('\n'),
	},
	logLevel: 'info',
})
