/**
 * Everything the listener hears goes through one GainNode so that level changes are smoothed:
 * stepping `audio.volume` or cutting the signal with `pause()` in the middle of a waveform
 * produces audible clicks ("zipper noise"). The visualizer taps the output of this node too.
 */

// Time constant of the exponential approach to the target level: ~95% reached after 3x this.
const SMOOTHING_SECONDS = 0.015;
// Long enough for the smoothing above to reach silence, so pausing/switching right after
// `setLevel(0)` cuts an already silent signal.
const FADE_MS = 60;

interface LegacyAudioWindow {
	AudioContext?: typeof AudioContext;
	webkitAudioContext?: typeof AudioContext;
}

// Context state changes can race with teardown; failures here are harmless.
function ignoreError() {
	/* noop */
}

class AudioOutput {
	readonly context: AudioContext;
	/** Post-gain node: connect analysers here to visualize what is actually heard. */
	readonly node: GainNode;

	private readonly source: MediaElementAudioSourceNode;

	constructor(element: HTMLAudioElement, initialLevel: number) {
		// Safari < 14.1 only ships the prefixed constructor.
		const legacyWindow = window as unknown as LegacyAudioWindow;
		const AudioContextClass = legacyWindow.AudioContext ?? legacyWindow.webkitAudioContext;
		if (!AudioContextClass) throw new Error('Web Audio API is not supported');

		this.context = new AudioContextClass();
		this.node = this.context.createGain();
		this.node.gain.value = initialLevel;

		// From now on the Web Audio graph is the only volume control: the element stays at 1.
		element.volume = 1;
		this.source = this.context.createMediaElementSource(element);
		this.source.connect(this.node);
		this.node.connect(this.context.destination);
	}

	/** Smoothly moves the output level to `level` (0..1). */
	setLevel(level: number) {
		const { gain } = this.node;
		const now = this.context.currentTime;
		gain.cancelScheduledValues(now);
		gain.setTargetAtTime(level, now, SMOOTHING_SECONDS);
	}

	// A context created outside a user gesture starts "suspended" and plays silence once the
	// <audio> element is routed through it, so it must be resumed explicitly.
	resume() {
		if (this.context.state === 'suspended') {
			this.context.resume().catch(ignoreError);
		}
	}

	destroy() {
		this.source.disconnect();
		this.node.disconnect();
		if (this.context.state !== 'closed') this.context.close().catch(ignoreError);
	}
}

export { AudioOutput, FADE_MS };
