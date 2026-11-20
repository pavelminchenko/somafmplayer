const INTERVAL_MS = 1000;

interface WatchdogOptions {
	getElement: () => HTMLAudioElement | null;
	/** Only a player that wants sound can stall; a paused one is not "stuck". */
	shouldWatch: () => boolean;
	/** How long the element may stand still before the connection counts as gone. */
	limitMs: () => number;
	/** Called (from the timer) when the element made no progress for `limitMs()`. */
	onStall: () => void;
}

/**
 * Watches that the element's `currentTime` keeps advancing while sound is wanted. A reset live
 * connection often raises no event at all (in Chromium the element just stops), so progress is
 * the only reliable signal.
 */
function createWatchdog(options: WatchdogOptions) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastTime = -1;
	let lastProgressAt = 0;

	function check() {
		const element = options.getElement();
		if (!element || !options.shouldWatch()) return;

		const now = Date.now();
		if (element.currentTime !== lastTime) {
			lastTime = element.currentTime;
			lastProgressAt = now;
		}
		if (now - lastProgressAt > options.limitMs()) options.onStall();
	}

	/** Remembers where the stream is now; only a change from here counts as progress. */
	function markProgress() {
		lastTime = options.getElement()?.currentTime ?? -1;
		lastProgressAt = Date.now();
	}

	function stop() {
		clearInterval(timer);
		timer = undefined;
	}

	/** (Re)starts watching from "now". */
	function start() {
		stop();
		markProgress();
		timer = setInterval(check, INTERVAL_MS);
	}

	return {
		start,
		stop,
		markProgress,
		isRunning: () => timer !== undefined,
	};
}

export { createWatchdog };
