import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReconnector } from '@/composables/player/reconnector';

function setup() {
	vi.useFakeTimers();
	return createReconnector({ maxAttempts: 3, baseDelayMs: 1000 });
}

afterEach(() => {
	vi.useRealTimers();
});

describe('createReconnector', () => {
	it('retries after 1 s, 2 s and 4 s, then reports exhaustion', () => {
		const reconnector = setup();
		const run = vi.fn();

		expect(reconnector.schedule(run)).toBe('scheduled');
		vi.advanceTimersByTime(999);
		expect(run).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(run).toHaveBeenCalledTimes(1);

		expect(reconnector.schedule(run)).toBe('scheduled');
		vi.advanceTimersByTime(2000);
		expect(run).toHaveBeenCalledTimes(2);

		expect(reconnector.schedule(run)).toBe('scheduled');
		vi.advanceTimersByTime(4000);
		expect(run).toHaveBeenCalledTimes(3);

		expect(reconnector.schedule(run)).toBe('exhausted');
		vi.advanceTimersByTime(60000);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it('counts the attempts', () => {
		const reconnector = setup();
		expect(reconnector.attempt.value).toBe(0);
		reconnector.schedule(vi.fn());
		reconnector.schedule(vi.fn());
		expect(reconnector.attempt.value).toBe(2);
	});

	it('cancel() drops a pending retry but keeps the count', () => {
		const reconnector = setup();
		const run = vi.fn();
		reconnector.schedule(run);

		reconnector.cancel();
		vi.advanceTimersByTime(10000);

		expect(run).not.toHaveBeenCalled();
		expect(reconnector.attempt.value).toBe(1);
	});

	it('reset() drops a pending retry and starts over from the shortest delay', () => {
		const reconnector = setup();
		const run = vi.fn();
		reconnector.schedule(vi.fn());
		reconnector.schedule(vi.fn());

		reconnector.reset();
		expect(reconnector.attempt.value).toBe(0);
		reconnector.schedule(run);
		vi.advanceTimersByTime(1000);

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
