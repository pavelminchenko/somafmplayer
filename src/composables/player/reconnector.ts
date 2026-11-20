interface ReconnectorOptions {
	/** How long to keep trying, counted from the first failure after the stream was last healthy. */
	budgetMs: number;
	/** Pause between a failure and the next attempt. Steady: a dead server is not worth hammering. */
	intervalMs: number;
}

/**
 * Schedules reconnect attempts at a steady pace for a limited time. An outage the user
 * would call short (a few seconds, or half a minute) is simply waited out; only a long one ends in
 * `'exhausted'`.
 */
function createReconnector(options: ReconnectorOptions) {
	let scheduledAny = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let startedAt = 0;

	function cancel() {
		clearTimeout(timer);
		timer = undefined;
	}

	/** Starts over (a stream is healthy again, or a new one begins). Also cancels a pending retry. */
	function reset() {
		cancel();
		scheduledAny = false;
		startedAt = 0;
	}

	/**
	 * Schedules `run` after the interval. Returns `'exhausted'` (and
	 * schedules nothing) once the time budget since the first failure is used up.
	 */
	function schedule(run: () => void): 'scheduled' | 'exhausted' {
		const now = Date.now();
		if (!scheduledAny) startedAt = now;
		if (now - startedAt >= options.budgetMs) return 'exhausted';

		scheduledAny = true;
		cancel();
		timer = setTimeout(() => {
			timer = undefined;
			run();
		}, options.intervalMs);
		return 'scheduled';
	}

	return {
		schedule,
		cancel,
		reset,
	};
}

export { createReconnector };
