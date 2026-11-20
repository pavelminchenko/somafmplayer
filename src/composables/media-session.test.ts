import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useMediaSession } from '@/composables/media-session';
import { useMainStore } from '@/stores/main-store';
import type { Channel } from '@/types';

type Handler = (() => void) | null;

function makeSession() {
	const handlers = new Map<string, Handler>();
	return {
		handlers,
		metadata: null as unknown,
		playbackState: 'none',
		setActionHandler: vi.fn((action: string, handler: Handler) => {
			handlers.set(action, handler);
		}),
	};
}

const channel = {
	id: 'groovesalad',
	title: 'Groove Salad',
	xlimage: 'https://somafm.com/img/groovesalad-x.jpg',
	songs: [{ title: 'Song', artist: 'Artist' }],
} as unknown as Channel;

let session: ReturnType<typeof makeSession>;

beforeEach(() => {
	setActivePinia(createPinia());
	session = makeSession();
	vi.stubGlobal('navigator', { mediaSession: session });
	// Minimal stand-in for the browser's MediaMetadata: it only stores its init dictionary.
	// eslint-disable-next-line @typescript-eslint/no-extraneous-class
	class FakeMediaMetadata {
		constructor(init: object) {
			Object.assign(this, init);
		}
	}
	vi.stubGlobal('MediaMetadata', FakeMediaMetadata);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const noop = vi.fn();

describe('useMediaSession', () => {
	it('publishes channel, song and playback state', async () => {
		const store = useMainStore();
		const isPlaying = ref(false);
		const scope = effectScope();
		scope.run(() => {
			useMediaSession(isPlaying, { play: noop, pause: noop, previous: noop, next: noop });
		});
		await nextTick();
		expect(session.metadata).toBeNull();
		expect(session.playbackState).toBe('paused');

		store.currentChannel = channel;
		isPlaying.value = true;
		await nextTick();

		expect(session.metadata).toMatchObject({
			title: 'Song',
			artist: 'Artist',
			album: 'Groove Salad',
			artwork: [{ src: 'https://somafm.com/img/groovesalad-x.jpg' }],
		});
		expect(session.playbackState).toBe('playing');
		scope.stop();
	});

	it('publishes the title read from the stream, split into artist and song', async () => {
		const store = useMainStore();
		store.currentChannel = channel;
		store.liveTitle = 'Live Artist - Live Song';
		const scope = effectScope();
		scope.run(() => {
			useMediaSession(ref(true), { play: noop, pause: noop, previous: noop, next: noop });
		});
		await nextTick();

		expect(session.metadata).toMatchObject({ title: 'Live Song', artist: 'Live Artist' });

		store.liveTitle = 'Next Artist - Next Song';
		await nextTick();
		expect(session.metadata).toMatchObject({ title: 'Next Song', artist: 'Next Artist' });
		scope.stop();
	});

	it('uses SomaFM as the artist when the stream title has none', async () => {
		const store = useMainStore();
		store.currentChannel = channel;
		store.liveTitle = 'Station jingle';
		const scope = effectScope();
		scope.run(() => {
			useMediaSession(ref(true), { play: noop, pause: noop, previous: noop, next: noop });
		});
		await nextTick();

		expect(session.metadata).toMatchObject({ title: 'Station jingle', artist: 'SomaFM' });
		scope.stop();
	});

	it('falls back to the channel title when no song is known', async () => {
		const store = useMainStore();
		store.currentChannel = { ...channel, songs: [] };
		const scope = effectScope();
		scope.run(() => {
			useMediaSession(ref(true), { play: noop, pause: noop, previous: noop, next: noop });
		});
		await nextTick();

		expect(session.metadata).toMatchObject({ title: 'Groove Salad', artist: 'SomaFM' });
		scope.stop();
	});

	it('routes media keys to the handlers and unregisters them on dispose', () => {
		const play = vi.fn();
		const next = vi.fn();
		const scope = effectScope();
		scope.run(() => {
			useMediaSession(ref(false), { play, pause: noop, previous: noop, next });
		});

		session.handlers.get('play')?.();
		session.handlers.get('nexttrack')?.();
		expect(play).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledOnce();

		scope.stop();
		expect(session.handlers.get('play')).toBeNull();
		expect(session.handlers.get('nexttrack')).toBeNull();
		expect(session.metadata).toBeNull();
		expect(session.playbackState).toBe('none');
	});

	it('is a no-op in browsers without Media Session', () => {
		vi.stubGlobal('navigator', {});
		const scope = effectScope();
		expect(() =>
			scope.run(() => {
				useMediaSession(ref(false), { play: noop, pause: noop, previous: noop, next: noop });
			}),
		).not.toThrow();
		scope.stop();
	});
});
