/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked() members are assertion targets */
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api.ts';
import { useMainStore } from '@/stores/main-store';
import type { ChannelSummary } from '@/types';

vi.mock('@/api.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/api.ts')>()),
	api: { getChannels: vi.fn(), getChannelSongs: vi.fn(), getStreamUrls: vi.fn() },
}));

const mocked = vi.mocked(api);

function makeChannel(id: string, playlists = [{ url: `https://api.somafm.com/${id}.pls` }]) {
	return { id, title: id.toUpperCase(), playlists } as unknown as ChannelSummary;
}

function song(title: string) {
	return { title, artist: 'Artist', album: '', albumArt: '', date: '' };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.resetAllMocks();
});

describe('setCurrentChannel', () => {
	it('commits channel, songs and stream together', async () => {
		mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/a']);
		mocked.getChannelSongs.mockResolvedValue([song('One')]);
		const store = useMainStore();

		await store.setCurrentChannel(makeChannel('a'));

		expect(store.currentChannel?.id).toBe('a');
		expect(store.currentChannel?.songs[0].title).toBe('One');
		expect(store.streamUrls).toEqual(['https://ice1.somafm.com/a']);
		expect(store.channelError).toBe('');
		expect(store.channelLoading).toBe(false);
	});

	it('records when the songs were loaded', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/a']);
		mocked.getChannelSongs.mockResolvedValue([song('One')]);
		const store = useMainStore();
		expect(store.songsUpdatedAt).toBe(0);

		await store.setCurrentChannel(makeChannel('a'));
		expect(store.songsUpdatedAt).toBe(Date.now());

		vi.advanceTimersByTime(15000);
		await store.refreshCurrentSongs();
		expect(store.songsUpdatedAt).toBe(Date.now());
		vi.useRealTimers();
	});

	it('keeps every mirror server of the stream', async () => {
		mocked.getStreamUrls.mockResolvedValue([
			'https://ice4.somafm.com/a',
			'https://ice6.somafm.com/a',
		]);
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();

		await store.setCurrentChannel(makeChannel('a'));

		expect(store.streamUrls).toEqual(['https://ice4.somafm.com/a', 'https://ice6.somafm.com/a']);
	});

	it('keeps the previous channel untouched while the next one is loading', async () => {
		mocked.getStreamUrls.mockResolvedValueOnce(['https://ice1.somafm.com/a']);
		mocked.getChannelSongs.mockResolvedValueOnce([song('A song')]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		const slowStream = deferred<string[]>();
		mocked.getStreamUrls.mockReturnValueOnce(slowStream.promise);
		mocked.getChannelSongs.mockResolvedValueOnce([song('B song')]);
		const pending = store.setCurrentChannel(makeChannel('b'));

		expect(store.currentChannel?.id).toBe('a');
		expect(store.currentChannel?.songs[0].title).toBe('A song');
		expect(store.channelLoading).toBe(true);

		slowStream.resolve(['https://ice1.somafm.com/b']);
		await pending;
		expect(store.currentChannel?.id).toBe('b');
	});

	it('ignores a slow response for a channel that was replaced (A then B)', async () => {
		const slowA = deferred<string[]>();
		mocked.getStreamUrls.mockImplementation((url: string) =>
			url.includes('/a.pls') ? slowA.promise : Promise.resolve(['https://ice1.somafm.com/b']),
		);
		mocked.getChannelSongs.mockImplementation((id: string) =>
			Promise.resolve([song(`song-${id}`)]),
		);
		const store = useMainStore();

		const first = store.setCurrentChannel(makeChannel('a'));
		await store.setCurrentChannel(makeChannel('b'));
		slowA.resolve(['https://ice1.somafm.com/a']); // A finally answers, after B won
		await first;

		expect(store.currentChannel?.id).toBe('b');
		expect(store.streamUrls).toEqual(['https://ice1.somafm.com/b']);
		expect(store.currentChannel?.songs[0].title).toBe('song-b');
		expect(store.channelError).toBe('');
		expect(store.channelLoading).toBe(false);
	});

	it('aborts the request of the replaced channel', async () => {
		const gate = deferred<string[]>();
		const signals: AbortSignal[] = [];
		mocked.getStreamUrls.mockImplementation((_url: string, signal?: AbortSignal) => {
			if (signal) signals.push(signal);
			return gate.promise;
		});
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();

		const first = store.setCurrentChannel(makeChannel('a'));
		const second = store.setCurrentChannel(makeChannel('b'));

		expect(signals[0].aborted).toBe(true);
		expect(signals[1].aborted).toBe(false);

		gate.resolve(['https://ice1.somafm.com/b']);
		await Promise.all([first, second]);
	});

	it('reports an error and keeps the old channel when the stream fails', async () => {
		mocked.getStreamUrls.mockResolvedValueOnce(['https://ice1.somafm.com/a']);
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		mocked.getStreamUrls.mockRejectedValueOnce(new Error('boom'));
		await store.setCurrentChannel(makeChannel('b'));

		expect(store.channelError).toBe('boom');
		expect(store.currentChannel?.id).toBe('a');
		expect(store.streamUrls).toEqual(['https://ice1.somafm.com/a']);
		expect(store.channelLoading).toBe(false);
	});

	it('does not require song history for playback', async () => {
		mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/a']);
		mocked.getChannelSongs.mockRejectedValue(new Error('songs down'));
		const store = useMainStore();

		await store.setCurrentChannel(makeChannel('a'));

		expect(store.channelError).toBe('');
		expect(store.streamUrls).toEqual(['https://ice1.somafm.com/a']);
		expect(store.currentChannel?.songs).toEqual([]);
	});

	it('fails clearly for a channel without playlists', async () => {
		const store = useMainStore();

		await store.setCurrentChannel(makeChannel('a', []));

		expect(store.channelError).toContain('has no playlists');
		expect(store.currentChannel).toBeNull();
		expect(store.streamUrls).toEqual([]);
		expect(mocked.getStreamUrls).not.toHaveBeenCalled();
	});

	it('cancels a pending switch when the user goes back to the playing channel', async () => {
		mocked.getStreamUrls.mockResolvedValueOnce(['https://ice1.somafm.com/a']);
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		const gate = deferred<string[]>();
		const signals: AbortSignal[] = [];
		mocked.getStreamUrls.mockImplementationOnce((_url: string, signal?: AbortSignal) => {
			if (signal) signals.push(signal);
			return gate.promise;
		});
		const pendingB = store.setCurrentChannel(makeChannel('b'));
		expect(store.channelLoading).toBe(true);

		await store.setCurrentChannel(makeChannel('a')); // changed my mind
		gate.resolve(['https://ice1.somafm.com/b']); // B answers late
		await pendingB;

		expect(signals[0].aborted).toBe(true);
		expect(store.currentChannel?.id).toBe('a');
		expect(store.streamUrls).toEqual(['https://ice1.somafm.com/a']);
		expect(store.requestedChannelId).toBe('a');
		expect(store.channelLoading).toBe(false);
	});

	it('ignores a repeated click on the channel that is already loading', async () => {
		const gate = deferred<string[]>();
		mocked.getStreamUrls.mockReturnValue(gate.promise);
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();

		const first = store.setCurrentChannel(makeChannel('a'));
		await store.setCurrentChannel(makeChannel('a'));
		gate.resolve(['https://ice1.somafm.com/a']);
		await first;

		expect(mocked.getStreamUrls).toHaveBeenCalledTimes(1);
		expect(store.currentChannel?.id).toBe('a');
	});

	it('does nothing when the same channel is selected again', async () => {
		mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/a']);
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));
		await store.setCurrentChannel(makeChannel('a'));

		expect(mocked.getStreamUrls).toHaveBeenCalledTimes(1);
	});

	it('retries the same channel after an error', async () => {
		mocked.getChannelSongs.mockResolvedValue([]);
		mocked.getStreamUrls.mockRejectedValueOnce(new Error('boom'));
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));
		expect(store.channelError).toBe('boom');

		mocked.getStreamUrls.mockResolvedValueOnce(['https://ice1.somafm.com/a']);
		await store.setCurrentChannel(makeChannel('a'));

		expect(store.channelError).toBe('');
		expect(store.currentChannel?.id).toBe('a');
	});
});

describe('refreshCurrentSongs', () => {
	it('drops a response that arrives after the channel was switched', async () => {
		mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/x']);
		mocked.getChannelSongs.mockResolvedValue([song('initial')]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		const slow = deferred<ReturnType<typeof song>[]>();
		mocked.getChannelSongs.mockReturnValueOnce(slow.promise);
		const refresh = store.refreshCurrentSongs();

		mocked.getChannelSongs.mockResolvedValueOnce([song('b-initial')]);
		await store.setCurrentChannel(makeChannel('b'));
		slow.resolve([song('stale song of A')]);
		await refresh;

		expect(store.currentChannel?.id).toBe('b');
		expect(store.currentChannel?.songs[0].title).toBe('b-initial');
	});

	it('swallows transient errors', async () => {
		mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/a']);
		mocked.getChannelSongs.mockResolvedValueOnce([song('kept')]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		mocked.getChannelSongs.mockRejectedValueOnce(new Error('offline'));
		await expect(store.refreshCurrentSongs()).resolves.toBeUndefined();
		expect(store.currentChannel?.songs[0].title).toBe('kept');
	});
});

const CACHE_KEY = 'somafm-player:channels';

function stubStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
	});
	return data;
}

describe('loadChannels', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('stores channels and clears the previous error on success', async () => {
		const store = useMainStore();
		mocked.getChannels.mockRejectedValueOnce(new Error('offline'));
		await store.loadChannels();
		expect(store.channelsError).toBe('offline');

		mocked.getChannels.mockResolvedValueOnce([makeChannel('a')]);
		await store.loadChannels();
		expect(store.channelsError).toBe('');
		expect(store.channels).toHaveLength(1);
	});

	it('writes the fresh list to the cache', async () => {
		const data = stubStorage();
		mocked.getChannels.mockResolvedValueOnce([makeChannel('a')]);
		await useMainStore().loadChannels();

		expect(JSON.parse(data.get(CACHE_KEY) ?? '[]')).toHaveLength(1);
	});

	it('shows the cached list immediately and refreshes it in the background', async () => {
		stubStorage({ [CACHE_KEY]: JSON.stringify([makeChannel('old')]) });
		const network = deferred<ChannelSummary[]>();
		mocked.getChannels.mockReturnValueOnce(network.promise);
		const store = useMainStore();

		await store.loadChannels(); // resolves without waiting for the network

		expect(store.channels.map(({ id }) => id)).toEqual(['old']);

		network.resolve([makeChannel('fresh')]);
		await vi.waitFor(() => {
			expect(store.channels.map(({ id }) => id)).toEqual(['fresh']);
		});
	});

	it('keeps the cached list and shows no error when the refresh fails', async () => {
		stubStorage({ [CACHE_KEY]: JSON.stringify([makeChannel('old')]) });
		mocked.getChannels.mockRejectedValueOnce(new Error('offline'));
		const store = useMainStore();

		await store.loadChannels();
		await vi.waitFor(() => {
			expect(mocked.getChannels).toHaveBeenCalled();
		});

		expect(store.channels.map(({ id }) => id)).toEqual(['old']);
		expect(store.channelsError).toBe('');
	});

	it('ignores a corrupted or malformed cache', async () => {
		stubStorage({ [CACHE_KEY]: JSON.stringify([{ nope: true }, 42]) });
		mocked.getChannels.mockRejectedValueOnce(new Error('offline'));
		const store = useMainStore();

		await store.loadChannels();

		expect(store.channels).toEqual([]);
		expect(store.channelsError).toBe('offline');
	});
});

async function startOn(id: string) {
	mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/x']);
	mocked.getChannelSongs.mockResolvedValue([]);
	const store = useMainStore();
	store.channels = ['a', 'b', 'c'].map((channelId) => makeChannel(channelId));
	await store.setCurrentChannel(makeChannel(id));
	return store;
}

describe('selectAdjacentChannel', () => {
	it('moves to the next and previous channel in list order', async () => {
		const store = await startOn('b');

		await store.selectAdjacentChannel(1);
		expect(store.currentChannel?.id).toBe('c');

		await store.selectAdjacentChannel(-1);
		await store.selectAdjacentChannel(-1);
		expect(store.currentChannel?.id).toBe('a');
	});

	it('stays put at both ends of the list', async () => {
		const store = await startOn('a');
		await store.selectAdjacentChannel(-1);
		expect(store.currentChannel?.id).toBe('a');

		await store.setCurrentChannel(makeChannel('c'));
		await store.selectAdjacentChannel(1);
		expect(store.currentChannel?.id).toBe('c');
	});

	it('keeps moving on quick repeated clicks while a channel is still loading', async () => {
		const store = await startOn('a');
		const gate = deferred<string[]>();
		mocked.getStreamUrls.mockReturnValue(gate.promise);

		const first = store.selectAdjacentChannel(1); // a -> b (still loading)
		const second = store.selectAdjacentChannel(1); // should go b -> c, not retry b
		gate.resolve(['https://ice1.somafm.com/y']);
		await Promise.all([first, second]);

		expect(store.currentChannel?.id).toBe('c');
	});

	it('does nothing before any channel is selected', async () => {
		const store = useMainStore();
		store.channels = [makeChannel('a')];
		await store.selectAdjacentChannel(1);
		expect(store.currentChannel).toBeNull();
		expect(mocked.getStreamUrls).not.toHaveBeenCalled();
	});
});

function ready(data: Map<string, string>, ...ids: string[]) {
	mocked.getChannels.mockResolvedValue(ids.map((id) => makeChannel(id)));
	mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/x']);
	mocked.getChannelSongs.mockResolvedValue([]);
	return data;
}

describe('last selected channel', () => {
	const LAST_KEY = 'somafm-player:last-channel';

	it('remembers the channel the user selected', async () => {
		const data = stubStorage();
		mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/x']);
		mocked.getChannelSongs.mockResolvedValue([]);

		await useMainStore().setCurrentChannel(makeChannel('b'));

		expect(data.get(LAST_KEY)).toBe('b');
	});

	it('does not remember a channel that failed to load', async () => {
		const data = stubStorage();
		mocked.getStreamUrls.mockRejectedValue(new Error('boom'));
		mocked.getChannelSongs.mockResolvedValue([]);

		await useMainStore().setCurrentChannel(makeChannel('b'));

		expect(data.has(LAST_KEY)).toBe(false);
	});

	it('restores it after the channels loaded, without autoplay', async () => {
		ready(stubStorage({ [LAST_KEY]: 'b' }), 'a', 'b', 'c');
		const store = useMainStore();

		await store.loadChannels();

		expect(store.currentChannel?.id).toBe('b');
		expect(store.streamUrls).toEqual(['https://ice1.somafm.com/x']);
		expect(store.autoplay).toBe(false);
	});

	it('autoplays again once the user picks a channel', async () => {
		ready(stubStorage({ [LAST_KEY]: 'b' }), 'a', 'b');
		const store = useMainStore();
		await store.loadChannels();

		await store.setCurrentChannel(makeChannel('a'));

		expect(store.autoplay).toBe(true);
		expect(store.currentChannel?.id).toBe('a');
	});

	it('shows the cached list at once and restores in the background', async () => {
		stubStorage({
			[LAST_KEY]: 'b',
			'somafm-player:channels': JSON.stringify([makeChannel('a'), makeChannel('b')]),
		});
		mocked.getChannels.mockReturnValue(deferred<ChannelSummary[]>().promise); // the network never answers
		mocked.getStreamUrls.mockResolvedValue(['https://ice1.somafm.com/x']);
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();

		await store.loadChannels();
		expect(store.channels).toHaveLength(2);

		await vi.waitFor(() => {
			expect(store.currentChannel?.id).toBe('b');
		});
	});

	it('ignores an unknown stored id', async () => {
		ready(stubStorage({ [LAST_KEY]: 'gone' }), 'a', 'b');
		const store = useMainStore();

		await store.loadChannels();

		expect(store.currentChannel).toBeNull();
		expect(mocked.getStreamUrls).not.toHaveBeenCalled();
	});

	it('does not override a channel the user already chose', async () => {
		ready(stubStorage({ [LAST_KEY]: 'b' }), 'a', 'b');
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		await store.restoreLastChannel();

		expect(store.currentChannel?.id).toBe('a');
	});

	it('fails silently when the restored channel cannot be loaded', async () => {
		ready(stubStorage({ [LAST_KEY]: 'b' }), 'a', 'b');
		mocked.getStreamUrls.mockRejectedValue(new Error('boom'));
		const store = useMainStore();

		await store.loadChannels();

		expect(store.currentChannel).toBeNull();
		expect(store.channelError).toBe('');
		expect(store.requestedChannelId).toBe('');
	});
});

async function playing(songs = [song('Api Song')]) {
	mocked.getStreamUrls.mockResolvedValue(['https://ice4.somafm.com/a']);
	mocked.getChannelSongs.mockResolvedValue(songs);
	const store = useMainStore();
	await store.setCurrentChannel(makeChannel('a'));
	return store;
}

describe('nowPlaying and liveTitle', () => {
	it('is empty before anything is playing', () => {
		expect(useMainStore().nowPlaying).toBeNull();
	});

	it('uses the newest song of the API history when the stream has no title', async () => {
		const store = await playing([song('Newest'), song('Older')]);
		expect(store.nowPlaying).toEqual({ artist: 'Artist', title: 'Newest' });
	});

	it('is null for a channel without any song history', async () => {
		const store = await playing([]);
		expect(store.nowPlaying).toBeNull();
	});

	it('prefers the title read from the stream and splits "Artist - Song"', async () => {
		const store = await playing();

		store.liveTitle = 'Jim and Jillian Graham - Seaside';

		expect(store.nowPlaying).toEqual({ artist: 'Jim and Jillian Graham', title: 'Seaside' });
	});

	it('shows a stream title without an artist as the title alone', async () => {
		const store = await playing();
		store.liveTitle = 'Station jingle';
		expect(store.nowPlaying).toEqual({ artist: '', title: 'Station jingle' });
	});

	it('falls back to the API song when the stream title is empty', async () => {
		const store = await playing([song('Api Song')]);
		store.liveTitle = '';
		expect(store.nowPlaying?.title).toBe('Api Song');
	});

	it('forgets the stream title when another channel is selected', async () => {
		const store = await playing();
		store.liveTitle = 'Old - Title';

		await store.setCurrentChannel(makeChannel('b'));

		expect(store.liveTitle).toBe('');
	});
});

describe('setLiveTitle', () => {
	it('stores a plain title as is', () => {
		const store = useMainStore();
		store.setLiveTitle('Artist - Song');
		expect(store.liveTitle).toBe('Artist - Song');
	});

	it('removes control, zero-width and bidi-override characters', () => {
		const store = useMainStore();
		store.setLiveTitle('A\u0000r\u0007tist\u202E - \u2066Song\u2069\u200B!\uFEFF');
		expect(store.liveTitle).toBe('A r tist - Song !');
	});

	it('squeezes whitespace and trims', () => {
		const store = useMainStore();
		store.setLiveTitle('  Artist \n\t  -   Song  ');
		expect(store.liveTitle).toBe('Artist - Song');
	});

	it('caps the length (the protocol allows 4 KB)', () => {
		const store = useMainStore();
		store.setLiveTitle('x'.repeat(4000));
		expect(store.liveTitle).toHaveLength(300);
		expect(store.liveTitle.endsWith('…')).toBe(true);
	});

	it('keeps non-Latin text intact and clears on an empty string', () => {
		const store = useMainStore();
		store.setLiveTitle('Мумий Тролль - Владивосток 2000 🎧');
		expect(store.liveTitle).toBe('Мумий Тролль - Владивосток 2000 🎧');
		store.setLiveTitle('');
		expect(store.liveTitle).toBe('');
	});
});
