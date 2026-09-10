import { EvaluatedFeatureFlag, FeatureFlagKey } from '@tldraw/dotcom-shared'

/**
 * The flags the client polls for, all off.
 *
 * On Cloudflare these were per-user rollouts held in KV: a percentage bucket for `rum_enabled` and
 * `commenting_enabled`, an allowlist for `mcp_server_access`. All three gate parts of the full
 * shape — real-user monitoring, commenting, and the board screenshot MCP server — and none of them
 * exists in this deployment, so there is nothing here to roll out to anyone and no store to hold
 * the state.
 *
 * The endpoint is kept rather than dropped because the client polls it on a timer and treats a
 * failure as an error worth logging. Answering with the same shape and the same values its own
 * fallback uses is the difference between a working deployment and one that writes a stack trace
 * to the console every few seconds.
 */
const FLAGS: Record<FeatureFlagKey, EvaluatedFeatureFlag> = {
	rum_enabled: { enabled: false },
	commenting_enabled: { enabled: false },
	mcp_server_access: { enabled: false },
}

export function getFeatureFlags(): Response {
	return Response.json(FLAGS, {
		headers: {
			// The client reads this to decide whether to poll again once someone signs in. There is one
			// account system here and no per-user flags, so the answer never changes.
			'x-authenticated': '0',
			'cache-control': 'no-store',
		},
	})
}
