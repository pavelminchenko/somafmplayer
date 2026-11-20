import { useStorage } from '@vueuse/core';
import {
	computed,
	onScopeDispose,
	readonly,
	type Ref,
	ref,
	shallowRef,
	watch,
	watchEffect,
} from 'vue';
import { AudioOutput, FADE_MS } from '@/lib/audio-output';
import type { LostReason } from '@/lib/mse-stream';
import {
	createElementTransport,
	createMseTransport,
	readTransportPreference,
	type StreamTransport,
	type TransportCallbacks,
	type TransportKind,
} from '@/lib/stream-transport';

type Phase = 'idle' | 'connecting' | 'playing' | 'buffering' | 'reconnecting' | 'paused' | 'failed';

// Phases in which the player is trying to produce sound (the button offers "Pause" = cancel).
const ACTIVE_PHASES = new Set<Phase>(['connecting', 'playing', 'buffering', 'reconnecting']);

// Live streams drop now and then (a reset connection often raises no `error` event at all, the
// element just stops advancing): retry a few times (1 s, 2 s, 4 s) before giving up.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
// No progress for this long while playing/buffering means the connection is gone.
const STALL_TIMEOUT_MS = 6000;
// ... and for this long while (re)connecting.
const CONNECT_TIMEOUT_MS = 10000;
const WATCHDOG_INTERVAL_MS = 1000;
// A live stream buffered this long ago is stale: resuming it would replay old audio (or stall).
const STALE_AFTER_PAUSE_MS = 15000;

const FAILED_MESSAGE =
	'Unable to connect to the stream after 3 attempts. Check your connection and press Play to try again.';

/** Anything that is not a number in [0, 1] (e.g. a corrupted stored value) means full volume. */
function normalizeVolume(value: number) {
	return value >= 0 && value <= 1 ? value : 1;
}

/**
 * State machine around an <audio> element for a live stream: connecting / playing / buffering /
 * reconnecting / paused / failed, user-intent aware resume, a watchdog that notices silent
 * connection drops, automatic reconnects, autoplay-policy handling and a persisted volume.
 *
 * Bind `listeners` to the element with `v-on`, and drive playback with `resume`/`pause`/`toggle`.
 */
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

function usePlayer(audio: Ref<HTMLAudioElement | null>, options: PlayerOptions = {}) {
	const phase = ref<Phase>('idle');
	const errorMessage = ref('');
	const reconnectAttempt = ref(0);
	// Track title read from the stream (MSE transport only), empty until the first one arrives.
	const liveTitle = ref('');

	// "Playing" from the user's point of view: sound is on the way, a click means "pause/cancel".
	const isPlaying = computed(() => ACTIVE_PHASES.has(phase.value));
	const statusMessage = computed(() => {
		switch (phase.value) {
			case 'connecting': {
				return 'Connecting…';
			}
			case 'buffering': {
				return 'Buffering…';
			}
			case 'reconnecting': {
				return `Connection lost. Reconnecting… (${String(reconnectAttempt.value)} of ${String(MAX_RECONNECT_ATTEMPTS)})`;
			}
			default: {
				return '';
			}
		}
	});

	// Persisted between visits.
	const volume = useStorage('somafm-player:volume', 1);
	volume.value = normalizeVolume(volume.value);

	// ---- click-free level control ----
	// The audible level is `volume * envelope`. The envelope is 1 while sound is wanted and 0 while
	// paused / switching streams; it is applied through a smoothed GainNode, so neither volume
	// changes nor pauses and stream switches cut the waveform abruptly (which would click).
	// Without Web Audio the element's own volume is used (no smoothing, no delayed pause).
	const output = shallowRef<AudioOutput | null>(null);
	let envelope = 1;
	let pauseTimer: ReturnType<typeof setTimeout> | undefined;

	function applyLevel() {
		const level = volume.value * envelope;
		if (output.value) {
			output.value.setLevel(level);
			return;
		}
		if (audio.value) audio.value.volume = level;
	}

	watchEffect(() => {
		const element = audio.value;
		if (element && !output.value) {
			try {
				output.value = new AudioOutput(element, volume.value * envelope);
			} catch {
				// Web Audio is unavailable: fall back to the element's volume.
			}
		}
		applyLevel(); // reacts to volume changes and to the output becoming available
	});

	function setEnvelope(value: 0 | 1) {
		envelope = value;
		applyLevel();
	}

	function cancelPendingPause() {
		clearTimeout(pauseTimer);
		pauseTimer = undefined;
	}

	// Set when the user pauses on purpose, so nothing resumes playback behind their back.
	let pausedByUser = false;
	// Once the user pressed Play, later (re)loads must start playing even for a restored channel.
	let userStarted = false;
	let pausedAt = 0;
	// The stream was not healthy when paused, so resuming must reconnect instead of continuing.
	let reloadOnResume = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	// True while our own retry reloads the stream, so its `loadstart` keeps the attempt counter.
	let isReconnecting = false;
	// True while switching from the MSE transport to the plain element after MSE failed to start.
	let isFallingBack = false;

	// ---- transport: how the stream URL reaches the element ----
	const getElement = () => audio.value;
	let mseEverPlayed = false;
	const transportCallbacks: TransportCallbacks = {
		onTitle: (title) => {
			liveTitle.value = title;
		},
		onLost: (reason) => {
			// eslint-disable-next-line @typescript-eslint/no-use-before-define
			handleTransportLost(reason);
		},
		onSuspended: () => {
			// The connection was dropped during a long pause: resuming must reconnect.
			reloadOnResume = true;
		},
	};
	// What the user asked for. A channel where MSE fails falls back to the element for that channel
	// only; MSE being unsupported altogether switches this for good.
	let preferredKind: TransportKind = options.transport ?? readTransportPreference();
	function createTransport(kind: TransportKind): StreamTransport {
		return kind === 'mse'
			? (options.createMseTransport?.(transportCallbacks) ??
					createMseTransport(getElement, transportCallbacks))
			: createElementTransport(getElement);
	}
	let transport = createTransport(preferredKind);

	// ---- watchdog: the element's `currentTime` must keep advancing while we want sound ----
	let watchdog: ReturnType<typeof setInterval> | undefined;
	let lastTime = -1;
	let lastProgressAt = 0;

	function stopWatchdog() {
		clearInterval(watchdog);
		watchdog = undefined;
	}

	function cancelReconnect() {
		clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
		isReconnecting = false;
	}

	onScopeDispose(() => {
		cancelReconnect();
		cancelPendingPause();
		stopWatchdog();
		transport.close();
		output.value?.destroy();
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
			stopWatchdog();
			phase.value = 'paused';
			errorMessage.value =
				error instanceof DOMException && error.name === 'NotAllowedError'
					? 'Playback was blocked by the browser. Press play to start.'
					: 'Unable to start playback';
		}
	}

	function checkProgress() {
		const element = audio.value;
		if (!element || !isPlaying.value) return;

		const now = Date.now();
		if (element.currentTime !== lastTime) {
			lastTime = element.currentTime;
			lastProgressAt = now;
		}
		const limit =
			phase.value === 'connecting' || phase.value === 'reconnecting'
				? CONNECT_TIMEOUT_MS
				: STALL_TIMEOUT_MS;
		// connectionLost() restarts the watchdog (via the reconnect), so the two are mutually recursive.
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		if (now - lastProgressAt > limit) connectionLost();
	}

	/** Remembers where the stream is now; only a change from here counts as progress. */
	function markProgress() {
		lastTime = audio.value?.currentTime ?? -1;
		lastProgressAt = Date.now();
	}

	function startWatchdog() {
		stopWatchdog();
		markProgress();
		watchdog = setInterval(checkProgress, WATCHDOG_INTERVAL_MS);
	}

	// ---- stream source: mirror servers and failover ----
	let mirrorIndex = 0;
	let currentSource = '';

	/** Connects to `url`: a new URL opens a new connection, the same URL reconnects. */
	function setSource(url: string, startNow = true) {
		if (currentSource === url) {
			transport.reopen();
			return;
		}
		currentSource = url;
		transport.open(url, startNow);
	}

	/** Restarts the stream, optionally on the next mirror (all of them serve the same channel). */
	function reloadStream({ nextMirror }: { nextMirror: boolean }) {
		const urls = options.sources?.value ?? [];
		if (urls.length === 0) {
			transport.reopen(); // no source management: reload whatever is set
			return;
		}
		if (nextMirror) mirrorIndex = (mirrorIndex + 1) % urls.length;
		setSource(urls[mirrorIndex] ?? urls[0]);
	}

	/** The transport reported that its connection is gone. */
	function handleTransportLost(reason: LostReason) {
		if (transport.kind === 'mse' && !mseEverPlayed) {
			// MSE never produced sound for this channel (CORS, decoder, ...): use the proven path.
			if (reason === 'unsupported') preferredKind = 'element'; // it will never work here
			// eslint-disable-next-line @typescript-eslint/no-use-before-define
			fallbackToElement();
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		connectionLost();
	}

	/** Gives up on MSE for this player and plays the same URL through the element itself. */
	function fallbackToElement() {
		transport.close();
		transport = createElementTransport(getElement);
		if (!currentSource) return;
		if (pausedByUser) {
			reloadOnResume = true;
			return;
		}
		isFallingBack = true;
		transport.open(currentSource, true);
		startWatchdog();
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		resumePlayback();
	}

	/** The stream died (error event, premature end or a stalled connection). */
	function connectionLost() {
		stopWatchdog();
		if (pausedByUser) {
			reloadOnResume = true; // the stream died while paused: resuming must reconnect
			return;
		}

		if (reconnectAttempt.value >= MAX_RECONNECT_ATTEMPTS) {
			phase.value = 'failed';
			errorMessage.value = FAILED_MESSAGE;
			return;
		}

		const delay = RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt.value;
		reconnectAttempt.value++;
		phase.value = 'reconnecting';
		clearTimeout(reconnectTimer);
		// The callback's promise never rejects (play() handles its own errors).
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		reconnectTimer = setTimeout(async () => {
			reconnectTimer = undefined;
			isReconnecting = true;
			reloadStream({ nextMirror: true });
			startWatchdog();
			await play();
		}, delay);
	}

	/** The user (or a media key) asked to play. */
	async function resume() {
		const element = audio.value;
		if (!element) return;

		// After a fatal error `play()` alone does nothing, and after a long pause (or one made
		// while the stream was unhealthy) the connection is dead or the buffer old: reload so the
		// live stream restarts from "now".
		const wasPausedLong = pausedAt > 0 && Date.now() - pausedAt > STALE_AFTER_PAUSE_MS;
		if (phase.value === 'failed') {
			// Every attempt failed: start over with the primary server.
			mirrorIndex = 0;
			reloadStream({ nextMirror: false });
		} else if (element.error) {
			reloadStream({ nextMirror: true }); // this mirror is failing, try the next one
		} else if (wasPausedLong || reloadOnResume) {
			reloadStream({ nextMirror: false });
		} else {
			// Healthy and recently paused: simply continue.
		}

		cancelReconnect();
		userStarted = true;
		cancelPendingPause();
		// Resumed during the fade-out of a pause: the element is still playing, bring the sound back.
		if (!element.paused) setEnvelope(1);
		reconnectAttempt.value = 0;
		pausedByUser = false;
		pausedAt = 0;
		reloadOnResume = false;
		errorMessage.value = '';
		phase.value = 'connecting';
		startWatchdog();
		transport.start(); // a restored channel did not connect until now
		await play();
	}

	/** Plays without awaiting (the promise never rejects: play() handles its own errors). */
	function resumePlayback() {
		play().catch(() => {
			/* handled inside play() */
		});
	}

	/** The user (or a media key) asked to pause (or to cancel a connection attempt). */
	function pause() {
		cancelReconnect();
		stopWatchdog();
		reloadOnResume = phase.value !== 'playing';
		pausedByUser = true;
		pausedAt = Date.now();
		phase.value = 'paused';

		const element = audio.value;
		if (!element) return;
		if (output.value) {
			// Fade out first; pausing a sounding stream mid-waveform clicks.
			setEnvelope(0);
			cancelPendingPause();
			pauseTimer = setTimeout(() => {
				pauseTimer = undefined;
				element.pause();
			}, FADE_MS);
		} else {
			element.pause();
		}
	}

	/** Fades the sound out (e.g. right before the stream is replaced). Resolves once silent. */
	async function duck() {
		if (!output.value) return;
		setEnvelope(0);
		await new Promise((resolve) => {
			setTimeout(resolve, FADE_MS);
		});
	}

	async function toggle() {
		if (isPlaying.value) pause();
		else await resume();
	}

	function setVolume(value: number) {
		volume.value = value;
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
			cancelReconnect();
			reconnectAttempt.value = 0;
			errorMessage.value = '';
			if (options.autoplay?.value === false && !userStarted) {
				// A channel restored after a reload: ready, but waiting for the Play button.
				pausedByUser = true;
				phase.value = 'paused';
				return;
			}
			phase.value = 'connecting';
			startWatchdog();
		},

		async canplay() {
			if (!pausedByUser && audio.value?.paused) await play();
		},

		playing() {
			setEnvelope(1); // fades in from silence (after a pause or a stream switch)
			if (transport.kind === 'mse') mseEverPlayed = true;
			phase.value = 'playing';
			reconnectAttempt.value = 0;
			errorMessage.value = '';
			markProgress();
			if (!watchdog) startWatchdog();
		},

		play() {
			// Somebody called play(): the intent is to hear sound.
			if (phase.value === 'idle' || phase.value === 'paused') phase.value = 'connecting';
		},

		pause() {
			// The browser (or the OS) paused the element; user pauses already set this.
			if (phase.value !== 'reconnecting' && phase.value !== 'failed') {
				stopWatchdog();
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
			if (currentSource !== '') {
				// Switching channels: nothing of the old stream (pending retry, watchdog) may fire on the
				// new one.
				cancelReconnect();
				stopWatchdog();
				reconnectAttempt.value = 0;
				errorMessage.value = '';
				if (phase.value === 'reconnecting' || phase.value === 'failed') phase.value = 'connecting';
				await duck();
			}
			if (token !== sourceToken) return; // a newer switch took over meanwhile

			mseEverPlayed = false;
			if (transport.kind !== preferredKind) {
				transport.close();
				transport = createTransport(preferredKind);
			}

			mirrorIndex = 0;
			liveTitle.value = ''; // a new channel: the old title no longer applies
			// A restored channel is only prepared (no connection) until the user presses Play.
			setSource(urls[0], (options.autoplay?.value ?? true) || userStarted);
		},
		{ immediate: true },
	);

	return {
		output,
		liveTitle: readonly(liveTitle),
		isPlaying,
		statusMessage,
		errorMessage: readonly(errorMessage),
		volume: readonly(volume),
		setVolume,
		resume,
		pause,
		toggle,
		listeners,
	};
}

export { normalizeVolume, usePlayer };
