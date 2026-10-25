/** What a refused call is told: when the service is asked again, and what the failures in a row were. */
export type Refusal = { until: number; failures: number; lastError: string };

export type BreakerOptions = {
	/** Failures in a row that open the breaker. */
	failures: number;
	/** How long it stays open. */
	coolDownMs: number;
	/** The clock, epoch ms. */
	now: () => number;
	/** Which errors count as a failure of the service (anything else, such as a closing server, passes through uncounted). */
	counts: (error: unknown) => boolean;
	/** The error a call gets while the breaker is open. */
	refuse: (refusal: Refusal) => Error;
};

export type Breaker = {
	/**
	 * Run `work` unless the breaker is open, in which case it throws `options.refuse(...)` without calling it. Once the
	 * cool-down is over calls go through again: the first failure opens the breaker again at once (it is still counted as a
	 * failure in a row), a success closes it.
	 */
	run<T>(work: () => Promise<T>): Promise<T>;
	/** Until when the service is not asked, or undefined when it is. */
	pausedUntil(): number | undefined;
};

/**
 * A circuit breaker for a service that can be slow or down (a slow Jev must not stretch a sync into minutes). A call
 * that takes the full timeout and its retries costs about a minute; after `failures` of them in a row the breaker opens, so
 * the rest of that sync and the next ones sort mail by the rules immediately, and Jev is tried again after `coolDownMs`.
 */
export function createBreaker(options: BreakerOptions): Breaker {
	let inARow = 0;
	let openUntil: number | undefined;
	let lastError = "";

	return {
		pausedUntil: () => (openUntil !== undefined && options.now() < openUntil ? openUntil : undefined),

		async run(work) {
			if (openUntil !== undefined && options.now() < openUntil) {
				throw options.refuse({ until: openUntil, failures: inARow, lastError });
			}
			try {
				const result = await work();
				inARow = 0;
				openUntil = undefined;
				return result;
			} catch (error) {
				if (options.counts(error)) {
					inARow += 1;
					lastError = error instanceof Error ? error.message : String(error);
					if (inARow >= options.failures) openUntil = options.now() + options.coolDownMs;
				}
				throw error;
			}
		},
	};
}
