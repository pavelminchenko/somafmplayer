interface ReconnectorOptions {
	/** How long to keep trying, counted from the first failure after the stream was last healthy. */
	budgetMs: number;
	/** Delay before the first retry; it doubles with every attempt (1 s, 2 s, 4 s ...). */
	baseDelayMs: number;
	/** The delay stops growing here, so retries keep coming at a steady pace until the budget ends. */
	maxDelayMs: number;
}

/**
 * Schedules reconnect attempts with exponential backoff for a limited time. An outage the user
 * would call short (a few seconds, or half a minute) is simply waited out; only a long one ends in
 * `'exhausted'`.
 */
function createReconnector(options: ReconnectorOptions) {
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let startedAt = 0;

	function cancel() {
		clearTimeout(timer);
		timer = undefined;
	}

	/** Starts over (a stream is healthy again, or a new one begins). Also cancels a pending retry. */
	function reset() {
		cancel();
		attempt = 0;
		startedAt = 0;
	}

	/**
	 * Schedules `run` after the backoff delay and counts the attempt. Returns `'exhausted'` (and
	 * schedules nothing) once the time budget since the first failure is used up.
	 */
	function schedule(run: () => void): 'scheduled' | 'exhausted' {
		const now = Date.now();
		if (attempt === 0) startedAt = now;
		if (now - startedAt >= options.budgetMs) return 'exhausted';

		const delay = Math.min(options.baseDelayMs * 2 ** attempt, options.maxDelayMs);
		attempt++;
		cancel();
		timer = setTimeout(() => {
			timer = undefined;
			run();
		}, delay);
		return 'scheduled';
	}

	return {
		schedule,
		cancel,
		reset,
	};
}

export { createReconnector };
