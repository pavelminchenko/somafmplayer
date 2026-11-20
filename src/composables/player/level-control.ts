import { useStorage } from '@vueuse/core';
import { readonly, type Ref, shallowRef, watchEffect } from 'vue';
import { AudioOutput, FADE_MS } from '@/lib/audio-output';

/** Anything that is not a number in [0, 1] (e.g. a corrupted stored value) means full volume. */
function normalizeVolume(value: number) {
	return value >= 0 && value <= 1 ? value : 1;
}

/**
 * Click-free level control. The audible level is `volume * envelope`: the envelope is 1 while
 * sound is wanted and 0 while paused / switching streams, and it is applied through a smoothed
 * GainNode, so neither volume changes nor pauses and stream switches cut the waveform abruptly
 * (which would click). Without Web Audio the element's own volume is used (no smoothing, no
 * delayed pause).
 */
function useLevelControl(audio: Ref<HTMLAudioElement | null>) {
	// Persisted between visits.
	const volume = useStorage('somafm-player:volume', 1);
	volume.value = normalizeVolume(volume.value);

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

	/** Stops a scheduled soft pause (the user pressed Play during the fade-out). */
	function cancelPendingPause() {
		clearTimeout(pauseTimer);
		pauseTimer = undefined;
	}

	/** Pauses the element; with Web Audio the sound fades out first (pausing mid-waveform clicks). */
	function pauseSoftly(element: HTMLAudioElement) {
		if (!output.value) {
			element.pause();
			return;
		}
		setEnvelope(0);
		cancelPendingPause();
		pauseTimer = setTimeout(() => {
			pauseTimer = undefined;
			element.pause();
		}, FADE_MS);
	}

	/** Fades the sound out (e.g. right before the stream is replaced). Resolves once silent. */
	async function duck() {
		if (!output.value) return;
		setEnvelope(0);
		await new Promise((resolve) => {
			setTimeout(resolve, FADE_MS);
		});
	}

	function setVolume(value: number) {
		volume.value = value;
	}

	/** Releases the audio graph and timers. */
	function dispose() {
		cancelPendingPause();
		output.value?.destroy();
	}

	return {
		volume: readonly(volume),
		output,
		setVolume,
		setEnvelope,
		cancelPendingPause,
		pauseSoftly,
		duck,
		dispose,
	};
}

export { normalizeVolume, useLevelControl };
