/** Let the rest of the process run: a long loop over rows must not hold the server's one thread until it is done. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Run `work` over `items`, `limit` at a time, and give the event loop a turn between groups. The first failure ends the
 * run (what is already in flight finishes; nothing new starts). Order of completion is not order of `items`.
 */
export async function forEachLimited<T>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	const size = Math.max(1, limit);
	for (let start = 0; start < items.length; start += size) {
		signal?.throwIfAborted();
		await Promise.all(items.slice(start, start + size).map(work));
		await yieldToEventLoop();
	}
}
