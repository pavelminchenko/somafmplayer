/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked() members are assertion targets */
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api.ts';
import { useMainStore } from '@/stores/main-store';
import type { Channel } from '@/types';

vi.mock('@/api.ts', () => ({
	api: { getChannels: vi.fn(), getChannelSongs: vi.fn(), getStreamUrl: vi.fn() },
}));

const mocked = vi.mocked(api);

function makeChannel(id: string, playlists = [{ url: `https://api.somafm.com/${id}.pls` }]) {
	return { id, title: id.toUpperCase(), playlists, songs: [] } as unknown as Channel;
}

function song(title: string) {
	return { title, artist: 'Artist', album: '', albumart: '', date: '' };
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
		mocked.getStreamUrl.mockResolvedValue('https://ice1.somafm.com/a');
		mocked.getChannelSongs.mockResolvedValue([song('One')]);
		const store = useMainStore();

		await store.setCurrentChannel(makeChannel('a'));

		expect(store.currentChannel?.id).toBe('a');
		expect(store.currentChannel?.songs[0].title).toBe('One');
		expect(store.streamUrl).toBe('https://ice1.somafm.com/a');
		expect(store.channelError).toBe('');
		expect(store.channelLoading).toBe(false);
	});

	it('keeps the previous channel untouched while the next one is loading', async () => {
		mocked.getStreamUrl.mockResolvedValueOnce('https://ice1.somafm.com/a');
		mocked.getChannelSongs.mockResolvedValueOnce([song('A song')]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		const slowStream = deferred<string>();
		mocked.getStreamUrl.mockReturnValueOnce(slowStream.promise);
		mocked.getChannelSongs.mockResolvedValueOnce([song('B song')]);
		const pending = store.setCurrentChannel(makeChannel('b'));

		expect(store.currentChannel?.id).toBe('a');
		expect(store.currentChannel?.songs[0].title).toBe('A song');
		expect(store.channelLoading).toBe(true);

		slowStream.resolve('https://ice1.somafm.com/b');
		await pending;
		expect(store.currentChannel?.id).toBe('b');
	});

	it('ignores a slow response for a channel that was replaced (A then B)', async () => {
		const slowA = deferred<string>();
		mocked.getStreamUrl.mockImplementation((url: string) =>
			url.includes('/a.pls') ? slowA.promise : Promise.resolve('https://ice1.somafm.com/b'),
		);
		mocked.getChannelSongs.mockImplementation((id: string) =>
			Promise.resolve([song(`song-${id}`)]),
		);
		const store = useMainStore();

		const first = store.setCurrentChannel(makeChannel('a'));
		await store.setCurrentChannel(makeChannel('b'));
		slowA.resolve('https://ice1.somafm.com/a'); // A finally answers, after B won
		await first;

		expect(store.currentChannel?.id).toBe('b');
		expect(store.streamUrl).toBe('https://ice1.somafm.com/b');
		expect(store.currentChannel?.songs[0].title).toBe('song-b');
		expect(store.channelError).toBe('');
		expect(store.channelLoading).toBe(false);
	});

	it('aborts the request of the replaced channel', async () => {
		const gate = deferred<string>();
		const signals: AbortSignal[] = [];
		mocked.getStreamUrl.mockImplementation((_url: string, signal?: AbortSignal) => {
			if (signal) signals.push(signal);
			return gate.promise;
		});
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();

		const first = store.setCurrentChannel(makeChannel('a'));
		const second = store.setCurrentChannel(makeChannel('b'));

		expect(signals[0].aborted).toBe(true);
		expect(signals[1].aborted).toBe(false);

		gate.resolve('https://ice1.somafm.com/b');
		await Promise.all([first, second]);
	});

	it('reports an error and keeps the old channel when the stream fails', async () => {
		mocked.getStreamUrl.mockResolvedValueOnce('https://ice1.somafm.com/a');
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		mocked.getStreamUrl.mockRejectedValueOnce(new Error('boom'));
		await store.setCurrentChannel(makeChannel('b'));

		expect(store.channelError).toBe('boom');
		expect(store.currentChannel?.id).toBe('a');
		expect(store.streamUrl).toBe('https://ice1.somafm.com/a');
		expect(store.channelLoading).toBe(false);
	});

	it('does not require song history for playback', async () => {
		mocked.getStreamUrl.mockResolvedValue('https://ice1.somafm.com/a');
		mocked.getChannelSongs.mockRejectedValue(new Error('songs down'));
		const store = useMainStore();

		await store.setCurrentChannel(makeChannel('a'));

		expect(store.channelError).toBe('');
		expect(store.streamUrl).toBe('https://ice1.somafm.com/a');
		expect(store.currentChannel?.songs).toEqual([]);
	});

	it('fails clearly for a channel without playlists', async () => {
		const store = useMainStore();

		await store.setCurrentChannel(makeChannel('a', []));

		expect(store.channelError).toContain('has no playlists');
		expect(store.currentChannel).toBeNull();
		expect(store.streamUrl).toBe('');
		expect(mocked.getStreamUrl).not.toHaveBeenCalled();
	});

	it('does nothing when the same channel is selected again', async () => {
		mocked.getStreamUrl.mockResolvedValue('https://ice1.somafm.com/a');
		mocked.getChannelSongs.mockResolvedValue([]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));
		await store.setCurrentChannel(makeChannel('a'));

		expect(mocked.getStreamUrl).toHaveBeenCalledTimes(1);
	});

	it('retries the same channel after an error', async () => {
		mocked.getChannelSongs.mockResolvedValue([]);
		mocked.getStreamUrl.mockRejectedValueOnce(new Error('boom'));
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));
		expect(store.channelError).toBe('boom');

		mocked.getStreamUrl.mockResolvedValueOnce('https://ice1.somafm.com/a');
		await store.setCurrentChannel(makeChannel('a'));

		expect(store.channelError).toBe('');
		expect(store.currentChannel?.id).toBe('a');
	});
});

describe('refreshCurrentSongs', () => {
	it('drops a response that arrives after the channel was switched', async () => {
		mocked.getStreamUrl.mockResolvedValue('https://ice1.somafm.com/x');
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
		mocked.getStreamUrl.mockResolvedValue('https://ice1.somafm.com/a');
		mocked.getChannelSongs.mockResolvedValueOnce([song('kept')]);
		const store = useMainStore();
		await store.setCurrentChannel(makeChannel('a'));

		mocked.getChannelSongs.mockRejectedValueOnce(new Error('offline'));
		await expect(store.refreshCurrentSongs()).resolves.toBeUndefined();
		expect(store.currentChannel?.songs[0].title).toBe('kept');
	});
});

describe('loadChannels', () => {
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
});
