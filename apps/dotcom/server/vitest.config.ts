/// <reference types="vitest" />
import { mergeConfig } from 'vitest/config'
import baseConfig from '../../../internal/config/vitest/node-preset'

export default mergeConfig(baseConfig, {
	test: {
		environment: 'node',
		transformMode: {
			web: [/\.([cm]?[jt]sx?)$/],
			ssr: [/\.([cm]?[jt]sx?)$/],
		},
		pool: 'forks',
		poolOptions: {
			// node:sqlite is unflagged from Node 24 on, which is what the image runs; the flag keeps
			// the suite working for anyone still on the repo's Node 22 floor.
			forks: { execArgv: ['--experimental-sqlite'] },
		},
	},
})
