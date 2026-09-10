import { AssetStore } from '../assets/store'
import { ServerConfig } from '../config'
import { UnoDirectoryService } from '../directory/directory'
import { PresenceRegistry } from '../presence/registry'

/**
 * What every route handler is handed alongside the request.
 *
 * This is what replaced Cloudflare's `env`: the same dependency injection, except the objects are
 * constructed at boot in `index.ts` rather than bound by the platform, so a test can build one.
 */
export interface AppContext {
	config: ServerConfig
	directory: UnoDirectoryService
	presence: PresenceRegistry
	/** Absent when the deployment configured no object storage; asset routes then answer 503. */
	assets: AssetStore | undefined
}
