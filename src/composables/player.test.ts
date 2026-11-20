import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { effectScope, nextTick, type Ref, ref } from 'vue';
import { normalizeVolume, usePlayer } from '@/composables/player';
import type { StreamTransport, TransportCallbacks } from '@/lib/stream-transport';

const FADE_MS = 60;
const FAILED = 'Unable to connect to the stream for a minute';

function makeAudio(paused = true) {
	return {
		paused,
		volume: 1,
		currentTime: 0,
		error: null as { code: number } | null,
		play: vi.fn(() => Promise.resolve()),
		pause: vi.fn(),
		load: vi.fn(),
		src: '',
		autoplay: true,
		preload: 'auto',
	};
}

function setup(audio = makeAudio(), options: Parameters<typeof usePlayer>[1] = {}) {
	const element = ref(audio as unknown as HTMLAudioElement);
	const scope = effectScope();
	const player = scope.run(() => usePlayer(element, options));
	if (!player) throw new Error('usePlayer did not run');
	return { audio, player, scope };
}

function setupWithTimers(audio = makeAudio(), options: Parameters<typeof usePlayer>[1] = {}) {
	vi.useFakeTimers();
	return setup(audio, options);
}

const domError = (name: string) => new DOMException('x', name);

/** A stream that is up: `loadstart` then `playing`. */
function startPlaying(player: ReturnType<typeof setup>['player']) {
	player.listeners.loadstart();
	player.listeners.playing();
}

/**
 * A stream that never delivers anything and raises no events, driven by the watchdog only: the
 * connect timeout (10 s) notices, a retry reloads the stream (which is when a real element fires
 * `loadstart`), and so on until the minute is over.
 */
function exhaustWithoutEvents(
	player: ReturnType<typeof setup>['player'],
	audio: ReturnType<typeof makeAudio>,
) {
	player.listeners.loadstart();
	let loads = audio.load.mock.calls.length;
	let source = audio.src;
	for (let second = 0; second < 300 && !player.errorMessage.value; second++) {
		vi.advanceTimersByTime(1000);
		if (audio.load.mock.calls.length !== loads || audio.src !== source) {
			loads = audio.load.mock.calls.length;
			source = audio.src;
			player.listeners.loadstart(); // the reload started by a retry
		}
	}
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
	it('shows "Connecting…" and retries with backoff: 1 s, 2 s, 4 s, 8 s, then every 8 s', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);

		player.listeners.error();
		expect(player.isPlaying.value).toBe(true);
		expect(player.statusMessage.value).toBe('Connecting…');
		vi.advanceTimersByTime(999);
		expect(audio.load).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(audio.load).toHaveBeenCalledTimes(1);
		expect(audio.play).toHaveBeenCalledTimes(1);
		player.listeners.loadstart(); // our own reload

		const waits = [2000, 4000, 8000, 8000, 8000];
		waits.forEach((wait, index) => {
			player.listeners.error();
			expect(player.statusMessage.value).toBe('Connecting…'); // a retry looks like the first connection
			vi.advanceTimersByTime(wait - 1);
			expect(audio.load).toHaveBeenCalledTimes(index + 1);
			vi.advanceTimersByTime(1);
			expect(audio.load).toHaveBeenCalledTimes(index + 2);
			player.listeners.loadstart();
		});
	});

	it('keeps trying for a minute and only then gives up', () => {
		const { audio, player } = setupWithTimers();
		startPlaying(player);

		const lose = (reloaded = true) => {
			player.listeners.error();
			vi.advanceTimersByTime(8000);
			if (reloaded) player.listeners.loadstart(); // a retry reloaded the stream
		};
		for (let round = 0; round < 8; round++) lose(); // the last one starts at 56 s: still within the minute
		expect(player.errorMessage.value).toBe('');
		expect(player.statusMessage.value).toBe('Connecting…');

		lose(false); // 64 s since the first loss: the minute is over, no retry is scheduled
		expect(player.errorMessage.value).toContain(FAILED);
		expect(player.statusMessage.value).toBe('');
		expect(player.isPlaying.value).toBe(false); // the button offers Play again
		const loads = audio.load.mock.calls.length;
		vi.advanceTimersByTime(120_000);
		expect(audio.load).toHaveBeenCalledTimes(loads); // no more attempts
	});

	it('a short outage is simply waited out', () => {
		const { player } = setupWithTimers();
		startPlaying(player);

		player.listeners.error();
		vi.advanceTimersByTime(1000);
		player.listeners.loadstart();
		player.listeners.error();
		vi.advanceTimersByTime(2000);
		player.listeners.loadstart();
		player.listeners.playing(); // the server is back

		expect(player.statusMessage.value).toBe('');
		expect(player.errorMessage.value).toBe('');
		player.listeners.error(); // a later drop gets a fresh minute
		expect(player.statusMessage.value).toBe('Connecting…');
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

		expect(player.statusMessage.value).toBe('Connecting…');
		expect(player.isPlaying.value).toBe(true);
	});

	it('also catches the stall after the browser reported buffering', () => {
		const { player } = setupWithTimers();
		startPlaying(player);
		player.listeners.waiting();
		expect(player.statusMessage.value).toBe('Buffering…');

		vi.advanceTimersByTime(7000);

		expect(player.statusMessage.value).toBe('Connecting…');
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

		expect(player.statusMessage.value).toBe('Connecting…');
	});

	it('shows the final message after a minute of failed attempts without any error event', () => {
		const { audio, player } = setupWithTimers();

		exhaustWithoutEvents(player, audio);

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
		exhaustWithoutEvents(player, audio);
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

const MIRRORS = [
	'https://ice4.somafm.com/deepspaceone-128-mp3',
	'https://ice6.somafm.com/deepspaceone-128-mp3',
	'https://ice2.somafm.com/deepspaceone-128-mp3',
	'https://ice5.somafm.com/deepspaceone-128-mp3',
];

function withMirrors() {
	const sources = ref([...MIRRORS]);
	return { sources, ...setupWithTimers(makeAudio(), { sources }) };
}

describe('usePlayer mirror servers', () => {
	it('starts on the first server and prepares autoplay/preload before assigning it', () => {
		const sources = ref([...MIRRORS]);
		const audio = makeAudio();
		setup(audio, { sources, autoplay: ref(false) });

		expect(audio.src).toBe(MIRRORS[0]);
		expect(audio.autoplay).toBe(false);
		expect(audio.preload).toBe('none');
	});

	it('fails over to the next mirror on every reconnect attempt', () => {
		const { audio, player } = withMirrors();
		startPlaying(player);

		player.listeners.error();
		vi.advanceTimersByTime(1000);
		expect(audio.src).toBe(MIRRORS[1]);
		player.listeners.loadstart();

		player.listeners.error();
		vi.advanceTimersByTime(2000);
		expect(audio.src).toBe(MIRRORS[2]);
		player.listeners.loadstart();

		player.listeners.error();
		vi.advanceTimersByTime(4000);
		expect(audio.src).toBe(MIRRORS[3]);
		expect(audio.load).not.toHaveBeenCalled(); // assigning src is what restarts the stream
	});

	it('wraps around to the first server after the last one', () => {
		const sources = ref([MIRRORS[0], MIRRORS[1]]);
		const { audio, player } = setupWithTimers(makeAudio(), { sources });
		startPlaying(player);

		player.listeners.error();
		vi.advanceTimersByTime(1000);
		expect(audio.src).toBe(MIRRORS[1]); // the last server
		player.listeners.loadstart();

		player.listeners.error();
		vi.advanceTimersByTime(2000);
		expect(audio.src).toBe(MIRRORS[0]); // back to the first one
		player.listeners.loadstart();

		player.listeners.error();
		vi.advanceTimersByTime(4000);
		expect(audio.src).toBe(MIRRORS[1]);
	});

	it('reuses load() when there is only one server', () => {
		const sources = ref([MIRRORS[0]]);
		const { audio, player } = setupWithTimers(makeAudio(), { sources });
		startPlaying(player);

		player.listeners.error();
		vi.advanceTimersByTime(1000);

		expect(audio.src).toBe(MIRRORS[0]);
		expect(audio.load).toHaveBeenCalledOnce();
	});

	it('starts again from the primary server after the minute of failed attempts', async () => {
		const { audio, player } = withMirrors();
		exhaustWithoutEvents(player, audio);
		expect(player.errorMessage.value).toContain(FAILED);
		expect(MIRRORS).toContain(audio.src); // some mirror, after many rotations

		await player.resume();

		expect(audio.src).toBe(MIRRORS[0]);
		expect(player.statusMessage.value).toBe('Connecting…');
	});

	it('tries the next mirror when the user resumes after a media error', async () => {
		const { audio, player } = withMirrors();
		startPlaying(player);
		audio.error = { code: 2 };

		await player.resume();

		expect(audio.src).toBe(MIRRORS[1]);
	});

	it('reloads the same mirror after a long pause (the server is fine, the buffer is old)', async () => {
		const { audio, player } = withMirrors();
		startPlaying(player);

		player.pause();
		vi.advanceTimersByTime(60000);
		await player.resume();

		expect(audio.src).toBe(MIRRORS[0]);
		expect(audio.load).toHaveBeenCalledOnce();
	});

	it('switches to the servers of a new channel only after fading the old stream out', async () => {
		const { audio, sources } = withMirrors();
		await nextTick();
		expect(audio.src).toBe(MIRRORS[0]);

		sources.value = ['https://ice2.somafm.com/groovesalad-128-mp3'];
		await nextTick();
		await vi.advanceTimersByTimeAsync(100);

		expect(audio.src).toBe('https://ice2.somafm.com/groovesalad-128-mp3');
	});

	it('lets the last of several quick channel switches win', async () => {
		const { audio, sources } = withMirrors();
		await nextTick();

		sources.value = ['https://ice2.somafm.com/a'];
		await nextTick();
		sources.value = ['https://ice2.somafm.com/b'];
		await nextTick();
		await vi.advanceTimersByTimeAsync(500);

		expect(audio.src).toBe('https://ice2.somafm.com/b');
	});
});

async function switchChannel(sources: Ref<string[]>, urls: string[]) {
	sources.value = urls;
	await nextTick();
	await vi.advanceTimersByTimeAsync(100);
}

describe('usePlayer MSE transport', () => {
	interface FakeTransport extends StreamTransport {
		open: Mock<StreamTransport['open']>;
		reopen: Mock<StreamTransport['reopen']>;
		start: Mock<StreamTransport['start']>;
		close: Mock<StreamTransport['close']>;
	}

	function setupMse(options: Parameters<typeof usePlayer>[1] = {}) {
		let callbacks!: TransportCallbacks;
		const created: FakeTransport[] = [];
		const sources = ref([...MIRRORS]);
		const audio = makeAudio();
		const result = setupWithTimers(audio, {
			sources,
			transport: 'mse',
			createMseTransport: (given) => {
				callbacks = given;
				const fake: FakeTransport = {
					kind: 'mse',
					open: vi.fn(),
					reopen: vi.fn(),
					start: vi.fn(),
					close: vi.fn(),
				};
				created.push(fake);
				return fake;
			},
			...options,
		});
		return {
			...result,
			audio,
			created,
			/** The MSE transport currently in use (the first one unless the player re-created it). */
			get transport() {
				// eslint-disable-next-line unicorn/prefer-at -- the TypeScript lib target has no Array#at
				return created[created.length - 1];
			},
			sources,
			callbacks: () => callbacks,
		};
	}

	it('opens the first mirror through the transport', () => {
		const { transport } = setupMse();
		expect(transport.open).toHaveBeenCalledWith(MIRRORS[0], true);
	});

	it('only prepares a restored channel and connects when the user presses Play', async () => {
		const { transport, player } = setupMse({ autoplay: ref(false) });
		expect(transport.open).toHaveBeenCalledWith(MIRRORS[0], false);
		expect(transport.start).not.toHaveBeenCalled();

		player.listeners.loadstart();
		await player.toggle();

		expect(transport.start).toHaveBeenCalledOnce();
	});

	it('exposes the title read from the stream and clears it for a new channel', async () => {
		const { player, callbacks, sources } = setupMse();

		callbacks().onTitle('Artist - Song');
		expect(player.liveTitle.value).toBe('Artist - Song');

		sources.value = ['https://ice2.somafm.com/other'];
		await nextTick();
		await vi.advanceTimersByTimeAsync(100);
		expect(player.liveTitle.value).toBe('');
	});

	it('falls back to the plain element when MSE fails before any sound', () => {
		const { audio, player, transport, callbacks } = setupMse();
		player.listeners.loadstart();

		callbacks().onLost('unsupported');

		expect(transport.close).toHaveBeenCalledOnce();
		expect(audio.src).toBe(MIRRORS[0]); // the element plays the same URL itself now
		expect(audio.autoplay).toBe(true);
		expect(player.statusMessage.value).toBe('Connecting…'); // not an error, not a counted attempt
		expect(player.errorMessage.value).toBe('');
	});

	it('forgets the stream title on fallback so API polling can take over', () => {
		const { player, callbacks } = setupMse();
		player.listeners.loadstart();
		callbacks().onTitle('Artist - Song'); // MSE delivered a title but never any sound

		callbacks().onLost('decode');

		expect(player.liveTitle.value).toBe('');
	});

	it('falls back for any failure while MSE has never produced sound (e.g. CORS)', () => {
		const { audio, player, callbacks } = setupMse();
		player.listeners.loadstart();

		callbacks().onLost('network');

		expect(audio.src).toBe(MIRRORS[0]);
	});

	it('falls back when MSE gives no sound before the connect timeout (a silent failure)', () => {
		const { audio, player, transport } = setupMse();
		player.listeners.loadstart(); // MSE attached, but nothing ever plays and no error event comes

		vi.advanceTimersByTime(11000); // the connection watchdog fires

		expect(transport.close).toHaveBeenCalledOnce();
		expect(audio.src).toBe(MIRRORS[0]); // the element plays the same URL itself
		expect(player.statusMessage.value).toBe('Connecting…'); // not a counted reconnect attempt
	});

	it('falls back when the element reports a decoder error before any sound', () => {
		const { audio, player } = setupMse();
		player.listeners.loadstart();

		player.listeners.error();

		expect(audio.src).toBe(MIRRORS[0]);
	});

	it('does not fall back for a watchdog loss once MSE has played (normal reconnect)', () => {
		const { player, transport } = setupMse();
		startPlaying(player);

		vi.advanceTimersByTime(8000); // the stream stalls
		expect(player.statusMessage.value).toBe('Connecting…');
		expect(transport.close).not.toHaveBeenCalled();
	});

	it('after the fallback the element transport handles reconnects as before', () => {
		const { audio, player, callbacks } = setupMse();
		player.listeners.loadstart();
		callbacks().onLost('network');
		player.listeners.loadstart(); // the element started loading
		player.listeners.error();
		vi.advanceTimersByTime(1000);

		expect(audio.src).toBe(MIRRORS[1]); // next mirror, through the element
	});

	it('prepares the element when MSE fails while the user has paused, and reloads on resume', async () => {
		const { audio, player, callbacks } = setupMse();
		startPlaying(player);
		player.pause();
		vi.advanceTimersByTime(100);

		callbacks().onLost('decode'); // the stream died while paused (MSE had played, so no fallback)
		expect(audio.src).toBe(''); // the element is not touched by a normal loss

		// A channel on which MSE never worked, paused before it produced sound:
		const second = setupMse();
		second.player.listeners.loadstart();
		second.player.pause();
		second.callbacks().onLost('decode');

		expect(second.audio.src).toBe(MIRRORS[0]); // the real URL is attached, not the dead blob
		expect(second.audio.autoplay).toBe(false);
		await second.player.resume();
		expect(second.audio.load).toHaveBeenCalledOnce();
		expect(player.isPlaying.value).toBe(false);
	});

	it('falls back for the failing channel only: the next channel tries MSE again', async () => {
		const { audio, player, callbacks, created, sources } = setupMse();
		player.listeners.loadstart();
		callbacks().onLost('network'); // MSE fails on this channel
		expect(audio.src).toBe(MIRRORS[0]); // played by the element

		await switchChannel(sources, ['https://ice2.somafm.com/other']);

		expect(created).toHaveLength(2); // a fresh MSE transport
		expect(created[1].open).toHaveBeenCalledWith('https://ice2.somafm.com/other', true);
	});

	it('stops trying MSE for good when it is unsupported', async () => {
		const { audio, player, callbacks, created, sources } = setupMse();
		player.listeners.loadstart();
		callbacks().onLost('unsupported');

		await switchChannel(sources, ['https://ice2.somafm.com/other']);

		expect(created).toHaveLength(1);
		expect(audio.src).toBe('https://ice2.somafm.com/other'); // the element from now on
	});

	it('a retry pending for the old channel does not fire on the new one', async () => {
		const { audio, player, transport, callbacks, sources } = setupMse();
		startPlaying(player);
		callbacks().onLost('network'); // a retry is scheduled in 1 s
		transport.open.mockClear();

		await switchChannel(sources, ['https://ice2.somafm.com/other']);
		vi.advanceTimersByTime(10000);

		expect(transport.open.mock.calls).toEqual([['https://ice2.somafm.com/other', true]]);
		expect(audio.load).not.toHaveBeenCalled();
		expect(player.statusMessage.value).toBe('Connecting…');
	});

	it('uses the normal reconnect (next mirror) once MSE has worked', () => {
		const { player, transport, callbacks } = setupMse();
		startPlaying(player);
		transport.open.mockClear();

		callbacks().onLost('network');
		expect(player.statusMessage.value).toBe('Connecting…');
		vi.advanceTimersByTime(1000);

		expect(transport.close).not.toHaveBeenCalled(); // no fallback
		expect(transport.open).toHaveBeenCalledWith(MIRRORS[1], true);
	});

	it('reconnects the same mirror through reopen() after a long pause', async () => {
		const { player, transport } = setupMse();
		startPlaying(player);

		player.pause();
		vi.advanceTimersByTime(60000);
		await player.resume();

		expect(transport.reopen).toHaveBeenCalledOnce();
	});

	it('reconnects on resume when the transport dropped the connection during a pause', async () => {
		const { player, transport, callbacks } = setupMse();
		startPlaying(player);
		player.pause();

		callbacks().onSuspended();
		await player.resume();

		expect(transport.reopen).toHaveBeenCalledOnce();
	});

	it('reconnects on resume when the stream died while the user had paused', async () => {
		const { player, transport, callbacks } = setupMse();
		startPlaying(player);
		player.pause();
		const attemptsBefore = player.statusMessage.value;

		callbacks().onLost('ended');
		vi.advanceTimersByTime(10000);
		expect(player.statusMessage.value).toBe(attemptsBefore); // no reconnect while paused
		await player.resume();

		expect(transport.reopen).toHaveBeenCalledOnce();
	});

	it('releases the connection when the player is disposed', () => {
		const { transport, scope } = setupMse();
		scope.stop();
		expect(transport.close).toHaveBeenCalledOnce();
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

	it('fades the old stream out before a channel switch replaces it', async () => {
		const web = stubWebAudio();
		const sources = ref([...MIRRORS]);
		const { audio, player } = setupWithTimers(makeAudio(), { sources });
		startPlaying(player);
		await nextTick();

		sources.value = ['https://ice2.somafm.com/groovesalad-128-mp3'];
		await nextTick();
		expect(web.lastTarget()).toBe(0); // fading out
		expect(audio.src).toBe(MIRRORS[0]); // the old stream is still attached
		await vi.advanceTimersByTimeAsync(FADE_MS);

		expect(audio.src).toBe('https://ice2.somafm.com/groovesalad-128-mp3');
		player.listeners.playing();
		expect(web.lastTarget()).toBe(1); // fades back in on the new stream
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
