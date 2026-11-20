import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatchdog } from '@/composables/player/watchdog';

function setup(initial: { watch?: boolean; limit?: number } = {}) {
	vi.useFakeTimers();
	const element = { currentTime: 0 };
	const state = { watch: initial.watch ?? true, limit: initial.limit ?? 6000 };
	const onStall = vi.fn();
	const watchdog = createWatchdog({
		getElement: () => element as unknown as HTMLAudioElement,
		shouldWatch: () => state.watch,
		limitMs: () => state.limit,
		onStall,
	});
	return { element, state, onStall, watchdog };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('createWatchdog', () => {
	it('reports a stall once the element stood still longer than the limit', () => {
		const { watchdog, onStall } = setup({ limit: 6000 });
		watchdog.start();

		vi.advanceTimersByTime(6000);
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);

		expect(onStall).toHaveBeenCalled();
	});

	it('does not stall while currentTime keeps advancing', () => {
		const { watchdog, element, onStall } = setup();
		watchdog.start();

		for (let second = 1; second <= 30; second++) {
			element.currentTime = second;
			vi.advanceTimersByTime(1000);
		}

		expect(onStall).not.toHaveBeenCalled();
	});

	it('markProgress() restarts the clock', () => {
		const { watchdog, onStall } = setup();
		watchdog.start();
		vi.advanceTimersByTime(5000);

		watchdog.markProgress();
		vi.advanceTimersByTime(5000);

		expect(onStall).not.toHaveBeenCalled();
	});

	it('ignores a player that is not trying to play', () => {
		const { watchdog, state, onStall } = setup();
		state.watch = false;
		watchdog.start();

		vi.advanceTimersByTime(60000);

		expect(onStall).not.toHaveBeenCalled();
	});

	it('reads the limit when it checks (connecting is allowed longer than playing)', () => {
		const { watchdog, state, onStall } = setup({ limit: 10000 });
		watchdog.start();
		vi.advanceTimersByTime(8000);

		state.limit = 6000; // e.g. the phase changed to "playing"
		vi.advanceTimersByTime(1000);

		expect(onStall).toHaveBeenCalled();
	});

	it('stop() ends the checks and isRunning() reflects the state', () => {
		const { watchdog, onStall } = setup();
		expect(watchdog.isRunning()).toBe(false);
		watchdog.start();
		expect(watchdog.isRunning()).toBe(true);

		watchdog.stop();
		vi.advanceTimersByTime(60000);

		expect(watchdog.isRunning()).toBe(false);
		expect(onStall).not.toHaveBeenCalled();
	});
});
