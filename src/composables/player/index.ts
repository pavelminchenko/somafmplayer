import { computed, onScopeDispose, readonly, type Ref, ref, watch } from 'vue';
import type { LostReason } from '@/lib/mse-stream';
import type { StreamTransport, TransportCallbacks, TransportKind } from '@/lib/stream-transport';
import { normalizeVolume, useLevelControl } from './level-control';
import { createReconnector } from './reconnector';
import { createStreamSource } from './stream-source';
import { createWatchdog } from './watchdog';

type Phase = 'idle' | 'connecting' | 'playing' | 'buffering' | 'reconnecting' | 'paused' | 'failed';

// Phases in which the player is trying to produce sound (the button offers "Pause" = cancel).
const ACTIVE_PHASES = new Set<Phase>(['connecting', 'playing', 'buffering', 'reconnecting']);

// Live streams drop now and then (a reset connection often raises no `error` event at all, the
// element just stops advancing): keep retrying (1 s, 2 s, 4 s, 8 s, then every 8 s) for a minute
// before giving up, so a short outage is simply waited out.
const RECONNECT_BUDGET_MS = 60000;
const RECONNECT_INTERVAL_MS = 10000;
// No progress for this long while playing/buffering means the connection is gone.
const STALL_TIMEOUT_MS = 6000;
// ... and for this long while (re)connecting.
const CONNECT_TIMEOUT_MS = 10000;
// A live stream buffered this long ago is stale: resuming it would replay old audio (or stall).
const STALE_AFTER_PAUSE_MS = 15000;

const FAILED_MESSAGE =
	'Unable to connect to the stream for a minute. Check your connection and press Play to try again.';

/** Placeholder for the hooks that are wired once the state machine's functions exist. */
const noop = () => {
	/* replaced by usePlayer */
};

interface PlayerOptions {
	/** Mirror servers of the current stream (the first one is tried first). */
	sources?: Ref<string[]>;
	/** False to prepare a stream without starting it (e.g. a channel restored after a reload). */
	autoplay?: Ref<boolean>;
	/** How the stream reaches the element; defaults to the user's choice (`?transport=`) or `element`. */
	transport?: TransportKind;
	/** Replaces the MSE transport (tests). */
	createMseTransport?: (callbacks: TransportCallbacks) => StreamTransport;
}

/**
 * State machine around an <audio> element for a live stream: connecting / playing / buffering /
 * reconnecting / paused / failed, user-intent aware resume, autoplay-policy handling.
 *
 * The pieces it coordinates live next to it: `level-control` (volume and click-free fades),
 * `watchdog` (silent connection drops), `reconnector` (retry backoff) and `stream-source` (mirror
 * servers, MSE/element transport and the fallback between them).
 *
 * Bind `listeners` to the element with `v-on`, and drive playback with `resume`/`pause`/`toggle`.
 */
function usePlayer(audio: Ref<HTMLAudioElement | null>, options: PlayerOptions = {}) {
	const phase = ref<Phase>('idle');
	const errorMessage = ref('');
	// Track title read from the stream (MSE transport only), empty until the first one arrives.
	const liveTitle = ref('');

	const level = useLevelControl(audio);
	const reconnector = createReconnector({
		budgetMs: RECONNECT_BUDGET_MS,
		intervalMs: RECONNECT_INTERVAL_MS,
	});

	// "Playing" from the user's point of view: sound is on the way, a click means "pause/cancel".
	const isPlaying = computed(() => ACTIVE_PHASES.has(phase.value));
	const statusMessage = computed(() => {
		switch (phase.value) {
			// A retry looks the same as the first connection: "trying to connect" is all there is to say.
			case 'connecting':
			case 'reconnecting': {
				return 'Connecting…';
			}
			case 'buffering': {
				return 'Buffering…';
			}
			default: {
				return '';
			}
		}
	});

	// Set when the user pauses on purpose, so nothing resumes playback behind their back.
	let pausedByUser = false;
	// Once the user pressed Play, later (re)loads must start playing even for a restored channel.
	let userStarted = false;
	let pausedAt = 0;
	// The stream was not healthy when paused, so resuming must reconnect instead of continuing.
	let reloadOnResume = false;
	// True while our own retry reloads the stream, so its `loadstart` keeps the attempt counter.
	let isReconnecting = false;
	// True while switching from the MSE transport to the plain element after MSE failed to start.
	let isFallingBack = false;

	// The watchdog and the stream source report into the state machine, which in turn restarts
	// them: close that loop here, once, instead of through use-before-define.
	const hooks: { stall: () => void; transportLost: (reason: LostReason) => void } = {
		stall: noop,
		transportLost: noop,
	};

	const watchdog = createWatchdog({
		getElement: () => audio.value,
		shouldWatch: () => isPlaying.value,
		limitMs: () =>
			phase.value === 'connecting' || phase.value === 'reconnecting'
				? CONNECT_TIMEOUT_MS
				: STALL_TIMEOUT_MS,
		onStall: () => {
			hooks.stall();
		},
	});

	const source = createStreamSource({
		getElement: () => audio.value,
		sources: options.sources,
		transport: options.transport,
		createMseTransport: options.createMseTransport,
		callbacks: {
			onTitle: (title) => {
				liveTitle.value = title;
			},
			onLost: (reason) => {
				hooks.transportLost(reason);
			},
			onSuspended: () => {
				// The connection was dropped during a long pause: resuming must reconnect.
				reloadOnResume = true;
			},
		},
	});

	/** Cancels a pending retry (the attempt counter is kept). */
	function stopRetry() {
		reconnector.cancel();
		isReconnecting = false;
	}

	/** Cancels a pending retry and forgets the attempts (a stream is healthy or a new one begins). */
	function resetRetries() {
		reconnector.reset();
		isReconnecting = false;
	}

	onScopeDispose(() => {
		stopRetry();
		watchdog.stop();
		source.close();
		level.dispose();
	});

	async function play() {
		if (!audio.value) return;
		try {
			await audio.value.play();
		} catch (error) {
			// AbortError: play() was interrupted by a new load/pause, which is expected.
			// NotSupportedError: the stream failed to load; the element's `error` event reports it
			// (and drives the reconnect), so don't overwrite that state here.
			if (
				error instanceof DOMException &&
				(error.name === 'AbortError' || error.name === 'NotSupportedError')
			) {
				return;
			}
			watchdog.stop();
			phase.value = 'paused';
			errorMessage.value =
				error instanceof DOMException && error.name === 'NotAllowedError'
					? 'Playback was blocked by the browser. Press play to start.'
					: 'Unable to start playback';
		}
	}

	/** Plays without awaiting (the promise never rejects: play() handles its own errors). */
	function resumePlayback() {
		play().catch(() => {
			/* handled inside play() */
		});
	}

	/** Gives up on MSE for this channel and plays the same URL through the element itself. */
	function fallbackToElement(reason?: LostReason) {
		const hasStream = source.fallbackToElement(reason);
		// The element reads no titles: whatever MSE delivered would go stale and keep API polling off.
		liveTitle.value = '';
		if (!hasStream) return;
		if (pausedByUser) {
			// Paused: only point the element at the real URL (without starting it), so that resuming
			// reloads that instead of the dead MediaSource.
			reloadOnResume = true;
			source.openCurrent(false);
			return;
		}
		isFallingBack = true;
		source.openCurrent(true);
		watchdog.start();
		resumePlayback();
	}

	/** The stream died (error event, premature end or a stalled connection). */
	function connectionLost() {
		watchdog.stop();
		if (source.isMseWithoutSound() && !pausedByUser) {
			// MSE gave no sound at all (a silent failure raises no error event): use the proven path
			// instead of burning reconnect attempts on a transport that does not work here.
			fallbackToElement();
			return;
		}
		if (pausedByUser) {
			reloadOnResume = true; // the stream died while paused: resuming must reconnect
			return;
		}

		const outcome = reconnector.schedule(() => {
			isReconnecting = true;
			source.reload({ nextMirror: true });
			watchdog.start();
			resumePlayback();
		});
		if (outcome === 'exhausted') {
			phase.value = 'failed';
			errorMessage.value = FAILED_MESSAGE;
			return;
		}
		phase.value = 'reconnecting';
	}

	/** The transport reported that its connection is gone. */
	function handleTransportLost(reason: LostReason) {
		if (source.isMseWithoutSound()) {
			// MSE never produced sound for this channel (CORS, decoder, ...): use the proven path.
			fallbackToElement(reason);
			return;
		}
		connectionLost();
	}

	hooks.stall = connectionLost;
	hooks.transportLost = handleTransportLost;

	/** The user (or a media key) asked to play. */
	async function resume() {
		const element = audio.value;
		if (!element) return;

		// After a fatal error `play()` alone does nothing, and after a long pause (or one made
		// while the stream was unhealthy) the connection is dead or the buffer old: reload so the
		// live stream restarts from "now".
		const wasPausedLong = pausedAt > 0 && Date.now() - pausedAt > STALE_AFTER_PAUSE_MS;
		if (phase.value === 'failed') {
			source.restartFromPrimary();
		} else if (element.error) {
			source.reload({ nextMirror: true }); // this mirror is failing, try the next one
		} else if (wasPausedLong || reloadOnResume) {
			source.reload({ nextMirror: false });
		} else {
			// Healthy and recently paused: simply continue.
		}

		resetRetries();
		userStarted = true;
		level.cancelPendingPause();
		// Resumed during the fade-out of a pause: the element is still playing, bring the sound back.
		if (!element.paused) level.setEnvelope(1);
		pausedByUser = false;
		pausedAt = 0;
		reloadOnResume = false;
		errorMessage.value = '';
		phase.value = 'connecting';
		watchdog.start();
		source.start(); // a restored channel did not connect until now
		await play();
	}

	/** The user (or a media key) asked to pause (or to cancel a connection attempt). */
	function pause() {
		stopRetry();
		watchdog.stop();
		reloadOnResume = phase.value !== 'playing';
		pausedByUser = true;
		pausedAt = Date.now();
		phase.value = 'paused';

		const element = audio.value;
		if (element) level.pauseSoftly(element);
	}

	async function toggle() {
		if (isPlaying.value) pause();
		else await resume();
	}

	const listeners = {
		loadstart() {
			pausedByUser = false;
			if (isFallingBack) {
				isFallingBack = false;
				phase.value = 'connecting';
				return;
			}
			if (isReconnecting) {
				isReconnecting = false;
				phase.value = 'reconnecting';
				return;
			}
			// A new stream (channel switch) starts with a clean slate.
			resetRetries();
			errorMessage.value = '';
			if (options.autoplay?.value === false && !userStarted) {
				// A channel restored after a reload: ready, but waiting for the Play button.
				pausedByUser = true;
				phase.value = 'paused';
				return;
			}
			phase.value = 'connecting';
			watchdog.start();
		},

		async canplay() {
			if (!pausedByUser && audio.value?.paused) await play();
		},

		playing() {
			level.setEnvelope(1); // fades in from silence (after a pause or a stream switch)
			source.markPlayed();
			phase.value = 'playing';
			reconnector.reset();
			errorMessage.value = '';
			watchdog.markProgress();
			if (!watchdog.isRunning()) watchdog.start();
		},

		play() {
			// Somebody called play(): the intent is to hear sound.
			if (phase.value === 'idle' || phase.value === 'paused') phase.value = 'connecting';
		},

		pause() {
			// The browser (or the OS) paused the element; user pauses already set this.
			if (phase.value !== 'reconnecting' && phase.value !== 'failed') {
				watchdog.stop();
				phase.value = 'paused';
			}
		},

		waiting() {
			if (phase.value === 'playing') phase.value = 'buffering';
		},

		ended() {
			// A live stream never ends: the server closed the connection.
			connectionLost();
		},

		error() {
			connectionLost();
		},
	};

	// A new stream (channel switch) replaces the old one only after it was faded out, otherwise
	// cutting a sounding stream clicks. The first source is applied at once.
	let sourceToken = 0;
	watch(
		() => [audio.value, options.sources?.value] as const,
		async ([element, urls]) => {
			if (!element || !urls || urls.length === 0) return;
			const token = ++sourceToken;
			if (source.hasSource()) {
				// Switching channels: nothing of the old stream (pending retry, watchdog) may fire on the
				// new one.
				resetRetries();
				watchdog.stop();
				errorMessage.value = '';
				if (phase.value === 'reconnecting' || phase.value === 'failed') phase.value = 'connecting';
				await level.duck();
			}
			if (token !== sourceToken) return; // a newer switch took over meanwhile

			liveTitle.value = ''; // a new channel: the old title no longer applies
			// A restored channel is only prepared (no connection) until the user presses Play.
			source.openChannel(urls, (options.autoplay?.value ?? true) || userStarted);
		},
		{ immediate: true },
	);

	return {
		output: level.output,
		liveTitle: readonly(liveTitle),
		isPlaying,
		statusMessage,
		errorMessage: readonly(errorMessage),
		volume: level.volume,
		setVolume: level.setVolume,
		resume,
		pause,
		toggle,
		listeners,
	};
}

export { normalizeVolume, usePlayer };
