import { readonly, ref } from 'vue';

interface ReconnectorOptions {
	maxAttempts: number;
	/** Delay before the first retry; it doubles with every attempt (1 s, 2 s, 4 s ...). */
	baseDelayMs: number;
}

/** Counts reconnect attempts and schedules the next one with exponential backoff. */
function createReconnector(options: ReconnectorOptions) {
	const attempt = ref(0);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function cancel() {
		clearTimeout(timer);
		timer = undefined;
	}

	/** Starts over (a stream is healthy again, or a new stream begins). Also cancels a pending retry. */
	function reset() {
		cancel();
		attempt.value = 0;
	}

	/**
	 * Schedules `run` after the backoff delay and counts the attempt. Returns `'exhausted'` (and
	 * schedules nothing) once all attempts were used.
	 */
	function schedule(run: () => void): 'scheduled' | 'exhausted' {
		if (attempt.value >= options.maxAttempts) return 'exhausted';
		const delay = options.baseDelayMs * 2 ** attempt.value;
		attempt.value++;
		cancel();
		timer = setTimeout(() => {
			timer = undefined;
			run();
		}, delay);
		return 'scheduled';
	}

	return {
		attempt: readonly(attempt),
		maxAttempts: options.maxAttempts,
		schedule,
		cancel,
		reset,
	};
}

export { createReconnector };
