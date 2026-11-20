import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { normalizeVolume, usePlayer } from '@/composables/player';

const FADE_MS = 60;
const FAILED = 'Unable to connect to the stream after 3 attempts';

function makeAudio(paused = true) {
	return {
		paused,
		volume: 1,
		currentTime: 0,
		error: null as { code: number } | null,
		play: vi.fn(() => Promise.resolve()),
		pause: vi.fn(),
		load: vi.fn(),
	};
}

function setup(audio = makeAudio()) {
	const element = ref(audio as unknown as HTMLAudioElement);
	const scope = effectScope();
	const player = scope.run(() => usePlayer(element));
	if (!player) throw new Error('usePlayer did not run');
	return { audio, player, scope };
}

function setupWithTimers(audio = makeAudio()) {
	vi.useFakeTimers();
	return setup(audio);
}

const domError = (name: string) => new DOMException('x', name);

/** A stream that is up: `loadstart` then `playing`. */
function startPlaying(player: ReturnType<typeof setup>['player']) {
	player.listeners.loadstart();
	player.listeners.playing();
}

/**
 * A stream that never delivers anything and raises no events, driven by the watchdog only.
 * Timeline: lost at 11 s -> reload at 12 s -> lost at 23 s -> reload at 25 s -> lost at 36 s ->
 * reload at 40 s -> lost at 51 s with no attempts left. `loadstart` is what the reload triggers.
 */
function exhaustWithoutEvents(player: ReturnType<typeof setup>['player']) {
	player.listeners.loadstart();
	for (const untilReload of [12000, 13000, 15000]) {
		vi.advanceTimersByTime(untilReload);
		player.listeners.loadstart();
	}
	vi.advanceTimersByTime(11000);
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('usePlayer status', () => {
	it('starts idle', () => {
		const { player } = setup();
		expect(player.isPlaying.value).toBe(false);
		expect(player.statusMessage.value).toBe('');
		expect(player.errorMessage.value).toBe('');
	});

	it('says Connecting… while the stream loads and Buffering… when it runs dry', () => {
		const { player } = setup();

		player.listeners.loadstart();
		expect(player.isPlaying.value).toBe(true); // a click now cancels the attempt
		expect(player.statusMessage.value).toBe('Connecting…');

		player.listeners.playing();
		expect(player.statusMessage.value).toBe('');

		player.listeners.waiting();
		expect(player.isPlaying.value).toBe(true);
		expect(player.statusMessage.value).toBe('Buffering…');

		player.listeners.playing();
		expect(player.statusMessage.value).toBe('');
	});

	it('is not playing after the browser paused the element', () => {
		const { player } = setup();
		startPlaying(player);

		player.listeners.pause();

		expect(player.isPlaying.value).toBe(false);
	});

	it('treats a bare play() as the intent to hear sound', () => {
		const { player } = setup();
		player.listeners.play();
		expect(player.statusMessage.value).toBe('Connecting…');
	});
});

describe('usePlayer automatic reconnect', () => {
	it('shows the attempt, retries with backoff (1 s, 2 s, 4 s) and then gives up', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);

		player.listeners.error();
		expect(player.isPlaying.value).toBe(true);
		expect(player.statusMessage.value).toBe('Connection lost. Reconnecting… (1 of 3)');
		vi.advanceTimersByTime(999);
		expect(audio.load).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(audio.load).toHaveBeenCalledTimes(1);
		expect(audio.play).toHaveBeenCalledTimes(1);
		player.listeners.loadstart(); // our own reload

		player.listeners.error();
		expect(player.statusMessage.value).toBe('Connection lost. Reconnecting… (2 of 3)');
		vi.advanceTimersByTime(1999);
		expect(audio.load).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(audio.load).toHaveBeenCalledTimes(2);
		player.listeners.loadstart();

		player.listeners.error();
		expect(player.statusMessage.value).toBe('Connection lost. Reconnecting… (3 of 3)');
		vi.advanceTimersByTime(4000);
		expect(audio.load).toHaveBeenCalledTimes(3);
		player.listeners.loadstart();

		player.listeners.error(); // the fourth failure: no more attempts
		expect(player.errorMessage.value).toContain(FAILED);
		expect(player.statusMessage.value).toBe('');
		expect(player.isPlaying.value).toBe(false); // the button offers Play again
		vi.advanceTimersByTime(60000);
		expect(audio.load).toHaveBeenCalledTimes(3);
	});

	it('reconnects when the server closes the stream (ended)', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);

		player.listeners.ended();
		vi.advanceTimersByTime(1000);

		expect(audio.load).toHaveBeenCalledOnce();
	});

	it('resets the backoff and the message once playback is back', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);
		player.listeners.error();
		vi.advanceTimersByTime(1000);
		player.listeners.loadstart();

		player.listeners.playing();
		expect(player.statusMessage.value).toBe('');
		expect(player.errorMessage.value).toBe('');

		player.listeners.error(); // a later drop starts again at 1 s
		vi.advanceTimersByTime(1000);
		expect(audio.load).toHaveBeenCalledTimes(2);
	});

	it('does not reconnect after the user paused, and pausing cancels a pending retry', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);
		player.listeners.error();

		player.pause();
		vi.advanceTimersByTime(10000);
		expect(audio.load).not.toHaveBeenCalled();
		expect(player.statusMessage.value).toBe('');

		player.listeners.error();
		vi.advanceTimersByTime(10000);
		expect(audio.load).not.toHaveBeenCalled();
		expect(player.errorMessage.value).toBe('');
	});

	it('starts over for a new stream (channel switch)', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);
		player.listeners.error(); // a retry is pending for the old stream

		player.listeners.loadstart(); // a different stream starts loading
		vi.advanceTimersByTime(5000);
		expect(audio.load).not.toHaveBeenCalled(); // the old retry was dropped
		expect(player.statusMessage.value).toBe('Connecting…');

		player.listeners.error();
		vi.advanceTimersByTime(1000); // counter was reset: first retry after 1 s again
		expect(audio.load).toHaveBeenCalledTimes(1);
	});

	it('stops retrying when the player is disposed', () => {
		const { audio, player, scope } = setupWithTimers();
		startPlaying(player);
		player.listeners.error();

		scope.stop();
		vi.advanceTimersByTime(10000);

		expect(audio.load).not.toHaveBeenCalled();
	});
});

describe('usePlayer watchdog (connection drops that raise no event)', () => {
	it('notices a stalled live stream whose currentTime stopped advancing', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);

		// The audio advances for a while ...
		for (let second = 1; second <= 5; second++) {
			audio.currentTime = second;
			vi.advanceTimersByTime(1000);
		}
		expect(player.statusMessage.value).toBe('');

		// ... then the connection is reset: no events, time just stands still (observed in Chromium).
		vi.advanceTimersByTime(5000);
		expect(player.statusMessage.value).toBe('');
		vi.advanceTimersByTime(2000);

		expect(player.statusMessage.value).toBe('Connection lost. Reconnecting… (1 of 3)');
		expect(player.isPlaying.value).toBe(true);
	});

	it('also catches the stall after the browser reported buffering', () => {
		const { player } = setupWithTimers();
		startPlaying(player);
		player.listeners.waiting();
		expect(player.statusMessage.value).toBe('Buffering…');

		vi.advanceTimersByTime(7000);

		expect(player.statusMessage.value).toContain('Reconnecting');
	});

	it('tolerates a short buffering blip', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);
		player.listeners.waiting();
		vi.advanceTimersByTime(3000);

		audio.currentTime = 5;
		player.listeners.playing();
		vi.advanceTimersByTime(20000 * 0); // no time passes without progress
		for (let second = 1; second <= 10; second++) {
			audio.currentTime = 5 + second;
			vi.advanceTimersByTime(1000);
		}

		expect(player.statusMessage.value).toBe('');
	});

	it('gives up on a connection attempt that never delivers sound (10 s)', () => {
		const { player } = setupWithTimers();
		player.listeners.loadstart();

		vi.advanceTimersByTime(9000);
		expect(player.statusMessage.value).toBe('Connecting…');
		vi.advanceTimersByTime(2000);

		expect(player.statusMessage.value).toContain('Reconnecting');
	});

	it('shows the final message after three failed attempts without any error event', () => {
		const { player } = setupWithTimers();

		exhaustWithoutEvents(player);

		expect(player.errorMessage.value).toContain(FAILED);
		expect(player.statusMessage.value).toBe('');
		expect(player.isPlaying.value).toBe(false);
	});

	it('does not run while the user has paused', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);
		player.pause();

		vi.advanceTimersByTime(60000);

		expect(audio.load).not.toHaveBeenCalled();
		expect(player.statusMessage.value).toBe('');
	});
});

describe('usePlayer errors', () => {
	it('explains a play() blocked by the autoplay policy', async () => {
		const audio = makeAudio();
		audio.play.mockRejectedValueOnce(domError('NotAllowedError'));
		const { player } = setup(audio);

		await player.listeners.canplay();

		expect(player.errorMessage.value).toContain('blocked by the browser');
		expect(player.isPlaying.value).toBe(false);
	});

	it('ignores AbortError from an interrupted play()', async () => {
		const audio = makeAudio();
		audio.play.mockRejectedValueOnce(domError('AbortError'));
		const { player } = setup(audio);

		await player.listeners.canplay();

		expect(player.errorMessage.value).toBe('');
	});

	it('leaves load failures to the error event (no competing message from play())', async () => {
		const audio = makeAudio();
		audio.play.mockRejectedValueOnce(domError('NotSupportedError'));
		const { player } = setup(audio);

		await player.resume();

		expect(player.errorMessage.value).toBe('');
	});

	it('reports any other play() failure', async () => {
		const audio = makeAudio();
		audio.play.mockRejectedValueOnce(new Error('boom'));
		const { player } = setup(audio);

		await player.resume();

		expect(player.errorMessage.value).toBe('Unable to start playback');
		expect(player.isPlaying.value).toBe(false);
	});
});

describe('usePlayer user intent', () => {
	it('starts playing on canplay by default', async () => {
		const { audio, player } = setup();
		await player.listeners.canplay();
		expect(audio.play).toHaveBeenCalledOnce();
	});

	it('does not resume on canplay after the user paused', async () => {
		const { audio, player } = setup();

		player.pause();
		await player.listeners.canplay();

		expect(audio.pause).toHaveBeenCalledOnce();
		expect(audio.play).not.toHaveBeenCalled();
	});

	it('resumes on canplay again for the next stream (loadstart resets the intent)', async () => {
		const { audio, player } = setup();
		player.pause();

		player.listeners.loadstart();
		await player.listeners.canplay();

		expect(audio.play).toHaveBeenCalledOnce();
	});

	it('does not call play() on canplay when the element is already playing', async () => {
		const { audio, player } = setup(makeAudio(false));
		await player.listeners.canplay();
		expect(audio.play).not.toHaveBeenCalled();
	});

	it('toggle pauses while playing and resumes while paused', async () => {
		const { audio, player } = setup();
		startPlaying(player);

		await player.toggle(); // playing -> pause
		expect(audio.pause).toHaveBeenCalledOnce();
		expect(player.isPlaying.value).toBe(false);

		await player.toggle(); // paused -> resume
		expect(audio.play).toHaveBeenCalledOnce();
		expect(player.statusMessage.value).toBe('Connecting…');
	});

	it('lets a click during a connection attempt cancel it', async () => {
		const { audio, player } = setupWithTimers();
		player.listeners.loadstart();

		await player.toggle();
		vi.advanceTimersByTime(60000);

		expect(player.isPlaying.value).toBe(false);
		expect(audio.load).not.toHaveBeenCalled();
		expect(player.statusMessage.value).toBe('');
	});
});

describe('usePlayer live stream recovery', () => {
	it('reloads the stream when resuming after a fatal media error', async () => {
		const audio = makeAudio();
		audio.error = { code: 2 };
		const { player } = setup(audio);

		await player.resume();

		expect(audio.load).toHaveBeenCalledOnce();
		expect(audio.play).toHaveBeenCalledOnce();
	});

	it('reloads when resuming after the connection gave up', async () => {
		const { audio, player } = setupWithTimers();
		exhaustWithoutEvents(player);
		expect(player.errorMessage.value).toContain(FAILED);
		audio.load.mockClear();

		await player.resume();

		expect(audio.load).toHaveBeenCalledOnce();
		expect(player.errorMessage.value).toBe('');
		expect(player.statusMessage.value).toBe('Connecting…');
	});

	it('does not reload after a short pause of a healthy stream', async () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);

		player.pause();
		vi.advanceTimersByTime(5000);
		await player.resume();

		expect(audio.load).not.toHaveBeenCalled();
		expect(audio.play).toHaveBeenCalledOnce();
	});

	it('reloads after a long pause so the live stream restarts from now', async () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);

		player.pause();
		vi.advanceTimersByTime(60000);
		await player.resume();

		expect(audio.load).toHaveBeenCalledOnce();
	});

	it('reloads when the stream was not healthy at the time of the pause', async () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);
		player.listeners.waiting(); // buffering, i.e. possibly dead

		player.pause();
		await player.resume();

		expect(audio.load).toHaveBeenCalledOnce();
	});

	it('does not reload when playback was merely blocked by the autoplay policy', async () => {
		const audio = makeAudio();
		audio.play.mockRejectedValueOnce(domError('NotAllowedError'));
		const { player } = setup(audio);
		await player.listeners.canplay();

		await player.resume();

		expect(audio.load).not.toHaveBeenCalled();
	});
});

describe('usePlayer volume (element volume fallback, no Web Audio)', () => {
	it('applies the volume to the element and updates it', async () => {
		const { audio, player } = setup();
		await nextTick();
		expect(audio.volume).toBe(1);

		player.setVolume(0.3);
		await nextTick();

		expect(player.volume.value).toBe(0.3);
		expect(audio.volume).toBe(0.3);
	});

	it('pauses immediately when there is no Web Audio to fade with', () => {
		const { audio, player } = setup();
		startPlaying(player);

		player.pause();

		expect(audio.pause).toHaveBeenCalledOnce();
	});
});

describe('normalizeVolume', () => {
	it.each([
		[0, 0],
		[0.4, 0.4],
		[1, 1],
		[7, 1],
		[-0.1, 1],
		[Number.NaN, 1],
	])('normalizes %f to %f', (input, expected) => {
		expect(normalizeVolume(input)).toBe(expected);
	});
});

/** Minimal Web Audio graph: records what is asked of the GainNode. */
function stubWebAudio() {
	const gain = { value: 1, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() };
	const node = { gain, connect: vi.fn(), disconnect: vi.fn() };
	const source = { connect: vi.fn(), disconnect: vi.fn() };
	const destination = {};
	const close = vi.fn(() => Promise.resolve());
	const resume = vi.fn(() => Promise.resolve());

	class FakeAudioContext {
		readonly currentTime = 0;
		readonly state = 'running';
		readonly destination = destination;
		readonly close = close;
		readonly resume = resume;
		readonly createGain = () => node;
		readonly createMediaElementSource = () => source;
	}
	vi.stubGlobal('window', { AudioContext: FakeAudioContext });

	const lastTarget = () => gain.setTargetAtTime.mock.lastCall?.[0] as number | undefined;
	return { gain, node, destination, close, resume, lastTarget };
}

function setupRestored() {
	const audio = makeAudio();
	const element = ref(audio as unknown as HTMLAudioElement);
	const scope = effectScope();
	const player = scope.run(() => usePlayer(element, { autoplay: ref(false) }));
	if (!player) throw new Error('usePlayer did not run');
	return { audio, player };
}

describe('usePlayer with a restored channel (autoplay off)', () => {
	it('stays paused and quiet when the stream is set, and never auto-starts', async () => {
		vi.useFakeTimers();
		const { audio, player } = setupRestored();

		player.listeners.loadstart();
		await player.listeners.canplay();
		vi.advanceTimersByTime(60000);

		expect(player.isPlaying.value).toBe(false);
		expect(player.statusMessage.value).toBe('');
		expect(audio.play).not.toHaveBeenCalled();
		expect(audio.load).not.toHaveBeenCalled(); // no watchdog, no reconnect attempts
	});

	it('plays without reloading when the user presses Play', async () => {
		const { audio, player } = setupRestored();
		player.listeners.loadstart();

		await player.toggle();

		expect(audio.play).toHaveBeenCalledOnce();
		expect(audio.load).not.toHaveBeenCalled();
		expect(player.statusMessage.value).toBe('Connecting…');
	});

	it('treats later reloads as wanted playback once the user has started', async () => {
		const { player } = setupRestored();
		player.listeners.loadstart();
		await player.toggle(); // the user starts

		player.listeners.loadstart(); // e.g. a reload after an error

		expect(player.statusMessage.value).toBe('Connecting…');
	});
});

describe('usePlayer click-free level changes (Web Audio)', () => {
	it('routes the element through a GainNode and leaves the element volume at 1', async () => {
		const web = stubWebAudio();
		const { audio, player } = setup();
		await nextTick();

		expect(player.output.value).not.toBeNull();
		expect(audio.volume).toBe(1);
		expect(web.node.connect).toHaveBeenCalledWith(web.destination);
	});

	it('smooths volume changes instead of stepping them', async () => {
		const web = stubWebAudio();
		const { player } = setup();
		await nextTick();

		player.setVolume(0.3);
		await nextTick();

		expect(web.gain.cancelScheduledValues).toHaveBeenCalled();
		expect(web.lastTarget()).toBe(0.3);
		const timeConstant = (web.gain.setTargetAtTime.mock.lastCall as number[])[2];
		expect(timeConstant).toBeGreaterThan(0);
	});

	it('fades out before pausing, so the waveform is not cut', () => {
		const web = stubWebAudio();
		const { audio, player } = setupWithTimers();
		startPlaying(player);

		player.pause();
		expect(web.lastTarget()).toBe(0);
		expect(audio.pause).not.toHaveBeenCalled(); // still sounding while the level falls
		vi.advanceTimersByTime(FADE_MS);

		expect(audio.pause).toHaveBeenCalledOnce();
	});

	it('cancels the pending pause when play is pressed during the fade-out', async () => {
		const web = stubWebAudio();
		const { audio, player } = setupWithTimers(makeAudio(false));
		startPlaying(player);

		player.pause();
		await player.resume();
		vi.advanceTimersByTime(FADE_MS * 2);

		expect(audio.pause).not.toHaveBeenCalled();
		expect(web.lastTarget()).toBe(1);
	});

	it('fades in when sound returns after a pause', () => {
		const web = stubWebAudio();
		const { player } = setupWithTimers();
		startPlaying(player);
		player.pause();
		vi.advanceTimersByTime(FADE_MS);
		expect(web.lastTarget()).toBe(0);

		player.listeners.playing();

		expect(web.lastTarget()).toBe(1);
	});

	it('ducks before a stream is replaced and resolves once silent', async () => {
		const web = stubWebAudio();
		const { player } = setupWithTimers();
		startPlaying(player);

		let done = false;
		const ducking = player.duck().then(() => {
			done = true;
		});
		expect(web.lastTarget()).toBe(0);
		await vi.advanceTimersByTimeAsync(FADE_MS - 1);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await ducking;

		expect(done).toBe(true);
	});

	it('applies the persisted volume and the envelope together (volume x envelope)', async () => {
		const web = stubWebAudio();
		const { player } = setupWithTimers();
		startPlaying(player);
		player.setVolume(0.5);
		await nextTick();
		expect(web.lastTarget()).toBe(0.5);

		player.pause();
		expect(web.lastTarget()).toBe(0);
		player.listeners.playing();
		expect(web.lastTarget()).toBe(0.5);
	});

	it('closes the audio context when the player is disposed', async () => {
		const web = stubWebAudio();
		const { scope } = setup();
		await nextTick();

		scope.stop();

		expect(web.close).toHaveBeenCalledOnce();
	});
});
