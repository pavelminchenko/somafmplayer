import { useStorage } from '@vueuse/core';
import { readonly, type Ref, ref, watchEffect } from 'vue';

// MediaError codes (the DOM constants are not available outside a browser).
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const mediaErrorMessages: Partial<Record<number, string>> = {
	[MEDIA_ERR_NETWORK]: 'Network error while loading the stream',
	[MEDIA_ERR_DECODE]: 'The stream could not be decoded',
	[MEDIA_ERR_SRC_NOT_SUPPORTED]: 'The stream is unavailable or not supported',
};

// A live stream buffered this long ago is stale: resuming it would replay old audio (or stall).
const STALE_AFTER_PAUSE_MS = 15000;

/** Anything that is not a number in [0, 1] (e.g. a corrupted stored value) means full volume. */
function normalizeVolume(value: number) {
	return value >= 0 && value <= 1 ? value : 1;
}

/**
 * State machine around an <audio> element: playing / buffering / error state, user-intent aware
 * resume, autoplay-policy handling and a persisted volume.
 *
 * Bind `listeners` to the element with `v-on`, and drive playback with `resume`/`pause`/`toggle`.
 */
function usePlayer(audio: Ref<HTMLAudioElement | null>) {
	const isPlaying = ref(false);
	const isWaiting = ref(false);
	const errorMessage = ref('');

	// Persisted between visits.
	const volume = useStorage('somafm-player:volume', 1);
	volume.value = normalizeVolume(volume.value);
	watchEffect(() => {
		if (audio.value) audio.value.volume = volume.value;
	});

	// Set when the user pauses on purpose, so `canplay` doesn't resume playback behind their back.
	let pausedByUser = false;
	let pausedAt = 0;

	async function play() {
		if (!audio.value) return;
		try {
			await audio.value.play();
		} catch (error) {
			// AbortError: play() was interrupted by a new load/pause, which is expected.
			if (error instanceof DOMException && error.name === 'AbortError') return;
			isPlaying.value = false;
			errorMessage.value =
				error instanceof DOMException && error.name === 'NotAllowedError'
					? 'Playback was blocked by the browser. Press play to start.'
					: 'Unable to start playback';
		}
	}

	/** The user (or a media key) asked to play. */
	async function resume() {
		const element = audio.value;
		if (!element) return;

		// After a fatal error `play()` alone does nothing, and after a long pause the buffer is
		// old: reload so the live stream restarts from "now".
		const wasPausedLong = pausedAt > 0 && Date.now() - pausedAt > STALE_AFTER_PAUSE_MS;
		if (element.error || wasPausedLong) element.load();

		pausedByUser = false;
		pausedAt = 0;
		errorMessage.value = '';
		await play();
	}

	/** The user (or a media key) asked to pause. */
	function pause() {
		pausedByUser = true;
		pausedAt = Date.now();
		audio.value?.pause();
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
			isPlaying.value = false;
			isWaiting.value = true;
			errorMessage.value = '';
			pausedByUser = false;
		},

		async canplay() {
			isWaiting.value = false;
			if (!pausedByUser && audio.value?.paused) await play();
		},

		playing() {
			isWaiting.value = false;
		},

		play() {
			isPlaying.value = true;
		},

		pause() {
			isPlaying.value = false;
		},

		waiting() {
			isWaiting.value = true;
		},

		ended() {
			isPlaying.value = false;
			isWaiting.value = false;
		},

		error(event: Event) {
			isPlaying.value = false;
			isWaiting.value = false;
			const code = (event.target as HTMLAudioElement).error?.code;
			errorMessage.value = (code ? mediaErrorMessages[code] : undefined) ?? 'Playback error';
		},
	};

	return {
		isPlaying: readonly(isPlaying),
		isWaiting: readonly(isWaiting),
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
