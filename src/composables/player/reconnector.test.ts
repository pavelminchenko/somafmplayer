import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReconnector } from '@/composables/player/reconnector';

function setup() {
	vi.useFakeTimers();
	return createReconnector({ budgetMs: 60000, intervalMs: 10000 });
}

afterEach(() => {
	vi.useRealTimers();
});

/** Waits for the scheduled retry and runs the next `schedule`, returning the delay that was used. */
function nextDelay(reconnector: ReturnType<typeof setup>) {
	const run = vi.fn();
	const outcome = reconnector.schedule(run);
	if (outcome === 'exhausted') return;
	for (let waited = 1; waited <= 20000; waited++) {
		vi.advanceTimersByTime(1);
		if (run.mock.calls.length > 0) return waited;
	}
	return Number.NaN;
}

describe('createReconnector', () => {
	it('retries at a steady 10 s pace', () => {
		const reconnector = setup();

		const delays = Array.from({ length: 4 }, () => nextDelay(reconnector));

		expect(delays).toEqual([10000, 10000, 10000, 10000]);
	});

	it('reports exhaustion once the minute since the first failure is used up', () => {
		const reconnector = setup();
		const run = vi.fn();

		let scheduled = 0;
		while (reconnector.schedule(run) === 'scheduled') {
			scheduled++;
			vi.advanceTimersByTime(10000); // also runs the retry
			if (scheduled > 100) throw new Error('never gave up');
		}

		expect(scheduled).toBe(6); // a minute of attempts, not three
		expect(run).toHaveBeenCalledTimes(scheduled);
		vi.advanceTimersByTime(120_000);
		expect(run).toHaveBeenCalledTimes(scheduled);
	});

	it('cancel() drops a pending retry but keeps the budget', () => {
		const reconnector = setup();
		const run = vi.fn();
		reconnector.schedule(run);

		reconnector.cancel();
		vi.advanceTimersByTime(10000);
		expect(run).not.toHaveBeenCalled();

		expect(nextDelay(reconnector)).toBe(10000);
	});

	it('reset() drops a pending retry and gives a fresh minute', () => {
		const reconnector = setup();
		reconnector.schedule(vi.fn());
		vi.advanceTimersByTime(90000); // long past the first minute
		reconnector.schedule(vi.fn());

		reconnector.reset();
		const run = vi.fn();
		expect(reconnector.schedule(run)).toBe('scheduled');
		vi.advanceTimersByTime(10000);

		expect(run).toHaveBeenCalledOnce();
	});

	it('a new schedule replaces the pending one', () => {
		const reconnector = setup();
		const first = vi.fn();
		const second = vi.fn();
		reconnector.schedule(first);
		reconnector.schedule(second);

		vi.advanceTimersByTime(10000);

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
	});
});
