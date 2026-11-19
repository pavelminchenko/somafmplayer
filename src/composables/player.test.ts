import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { normalizeVolume, usePlayer } from '@/composables/player';

function makeAudio(paused = true) {
	return {
		paused,
		volume: 1,
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

function mediaErrorEvent(code: number) {
	return { target: { error: { code } } } as unknown as Event;
}

const domError = (name: string) => new DOMException('x', name);

describe('usePlayer state', () => {
	it('tracks loading, buffering and playing', () => {
		const { player } = setup();

		player.listeners.loadstart();
		expect(player.isWaiting.value).toBe(true);
		expect(player.isPlaying.value).toBe(false);

		player.listeners.playing();
		player.listeners.play();
		expect(player.isWaiting.value).toBe(false);
		expect(player.isPlaying.value).toBe(true);

		player.listeners.waiting();
		expect(player.isWaiting.value).toBe(true);

		player.listeners.pause();
		expect(player.isPlaying.value).toBe(false);
	});

	it('resets everything when the stream ends', () => {
		const { player } = setup();
		player.listeners.play();
		player.listeners.waiting();

		player.listeners.ended();

		expect(player.isPlaying.value).toBe(false);
		expect(player.isWaiting.value).toBe(false);
	});

	it('clears a previous error when a new stream starts loading', () => {
		const { player } = setup();
		player.listeners.error(mediaErrorEvent(4));
		expect(player.errorMessage.value).not.toBe('');

		player.listeners.loadstart();
		expect(player.errorMessage.value).toBe('');
	});
});

describe('usePlayer errors', () => {
	it.each([
		[2, 'Network error'],
		[3, 'could not be decoded'],
		[4, 'unavailable or not supported'],
		[1, 'Playback error'],
	])('maps MediaError code %i to a readable message', (code, text) => {
		const { player } = setup();
		player.listeners.play();

		player.listeners.error(mediaErrorEvent(code));

		expect(player.errorMessage.value).toContain(text);
		expect(player.isPlaying.value).toBe(false);
		expect(player.isWaiting.value).toBe(false);
	});

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

	it('reports any other play() failure', async () => {
		const audio = makeAudio();
		audio.play.mockRejectedValueOnce(new Error('boom'));
		const { player } = setup(audio);

		await player.resume();

		expect(player.errorMessage.value).toBe('Unable to start playback');
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

	it('toggle pauses while playing and resumes (clearing the error) while paused', async () => {
		const { audio, player } = setup();
		player.listeners.error(mediaErrorEvent(2));

		await player.toggle(); // not playing -> resume
		expect(audio.play).toHaveBeenCalledOnce();
		expect(player.errorMessage.value).toBe('');

		player.listeners.play();
		await player.toggle(); // playing -> pause
		expect(audio.pause).toHaveBeenCalledOnce();
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

	it('does not reload after a short pause', async () => {
		vi.useFakeTimers();
		const { audio, player } = setup();

		player.pause();
		vi.advanceTimersByTime(5000);
		await player.resume();

		expect(audio.load).not.toHaveBeenCalled();
		expect(audio.play).toHaveBeenCalledOnce();
		vi.useRealTimers();
	});

	it('reloads after a long pause so the live stream restarts from now', async () => {
		vi.useFakeTimers();
		const { audio, player } = setup();

		player.pause();
		vi.advanceTimersByTime(60000);
		await player.resume();

		expect(audio.load).toHaveBeenCalledOnce();
		vi.useRealTimers();
	});

	it('does not reload when playback was merely blocked by autoplay policy', async () => {
		const audio = makeAudio();
		audio.play.mockRejectedValueOnce(domError('NotAllowedError'));
		const { player } = setup(audio);
		await player.listeners.canplay();

		await player.resume();

		expect(audio.load).not.toHaveBeenCalled();
	});
});

describe('usePlayer volume', () => {
	it('applies the volume to the element and updates it', async () => {
		const { audio, player } = setup();
		await nextTick();
		expect(audio.volume).toBe(1);

		player.setVolume(0.3);
		await nextTick();

		expect(player.volume.value).toBe(0.3);
		expect(audio.volume).toBe(0.3);
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
