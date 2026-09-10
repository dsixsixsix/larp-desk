/**
 * A token bucket per key, held in memory.
 *
 * This replaced Cloudflare's rate limiting binding, and the trade is the same one the presence
 * rooms make: a single process is the whole deployment, so one in-memory counter is the complete
 * picture. Two processes would each enforce their own half of the budget.
 */
export class RateLimiter {
	private buckets = new Map<string, { tokens: number; refilledAt: number }>()
	private readonly refillPerMs: number

	constructor(
		private readonly burst: number,
		refillPerSecond: number,
		/**
		 * How long an untouched bucket is kept. Only bounds memory: a bucket that has refilled to
		 * full is indistinguishable from one that never existed, so dropping it changes nothing.
		 */
		private readonly idleTtlMs = 10 * 60 * 1000
	) {
		this.refillPerMs = refillPerSecond / 1000
	}

	/** Spends one token, or reports that the key is over budget. */
	check(key: string, now = Date.now()): boolean {
		this.sweep(now)
		const bucket = this.buckets.get(key) ?? { tokens: this.burst, refilledAt: now }
		bucket.tokens = Math.min(
			this.burst,
			bucket.tokens + (now - bucket.refilledAt) * this.refillPerMs
		)
		bucket.refilledAt = now
		if (bucket.tokens < 1) {
			this.buckets.set(key, bucket)
			return false
		}
		bucket.tokens -= 1
		this.buckets.set(key, bucket)
		return true
	}

	private lastSweep = 0

	private sweep(now: number) {
		// Sweeping on every call would make each check O(keys); once a minute keeps the map bounded
		// without putting a scan in the request path.
		if (now - this.lastSweep < 60_000) return
		this.lastSweep = now
		for (const [key, bucket] of this.buckets) {
			if (now - bucket.refilledAt > this.idleTtlMs) this.buckets.delete(key)
		}
	}
}
