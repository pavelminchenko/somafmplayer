// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useSongRefresh } from '@/composables/song-refresh';
import { useMainStore } from '@/stores/main-store';

function setVisibility(state: 'hidden' | 'visible') {
	Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
	document.dispatchEvent(new Event('visibilitychange'));
}

function setup(playing: boolean) {
	const isPlaying = ref(playing);
	const store = useMainStore();
	const refresh = vi.spyOn(store, 'refreshCurrentSongs').mockResolvedValue();
	const scope = effectScope();
	scope.run(() => {
		useSongRefresh(isPlaying);
	});
	return { isPlaying, refresh, scope };
}

beforeEach(() => {
	vi.useFakeTimers();
	setActivePinia(createPinia());
	setVisibility('visible');
});

afterEach(() => {
	vi.useRealTimers();
});

describe('useSongRefresh', () => {
	it('refreshes at once when sound starts and then every 15 s', async () => {
		const { isPlaying, refresh } = setup(false);
		await vi.advanceTimersByTimeAsync(60000);
		expect(refresh).not.toHaveBeenCalled(); // paused: no polling at all

		isPlaying.value = true;
		await nextTick();
		expect(refresh).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(15000);
		expect(refresh).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30000);
		expect(refresh).toHaveBeenCalledTimes(4);
	});

	it('stops polling when playback stops', async () => {
		const { isPlaying, refresh } = setup(true);
		await nextTick();
		await vi.advanceTimersByTimeAsync(15000);
		const calls = refresh.mock.calls.length;

		isPlaying.value = false;
		await nextTick();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(refresh).toHaveBeenCalledTimes(calls);
	});

	it('stops while the tab is hidden and refreshes immediately when it is shown again', async () => {
		const { refresh } = setup(true);
		await nextTick();
		const calls = refresh.mock.calls.length;

		setVisibility('hidden');
		await nextTick();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(refresh).toHaveBeenCalledTimes(calls);

		setVisibility('visible');
		await nextTick();
		expect(refresh).toHaveBeenCalledTimes(calls + 1);
	});

	it('does not ask again right after the songs were loaded together with the channel', async () => {
		useMainStore().songsUpdatedAt = Date.now();
		const { isPlaying, refresh } = setup(false);

		isPlaying.value = true;
		await nextTick();
		expect(refresh).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(6000); // the songs are no longer fresh
		isPlaying.value = false;
		await nextTick();
		isPlaying.value = true;
		await nextTick();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('does not poll while the stream delivers the titles itself', async () => {
		const store = useMainStore();
		store.liveTitle = 'Artist - Song';
		const { isPlaying, refresh } = setup(false);

		isPlaying.value = true;
		await nextTick();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(refresh).not.toHaveBeenCalled();
	});

	it('starts polling (at once) when the stream titles are lost, e.g. after a fallback', async () => {
		const store = useMainStore();
		store.liveTitle = 'Artist - Song';
		const { isPlaying, refresh } = setup(true);
		await nextTick();
		await vi.advanceTimersByTimeAsync(60000);
		expect(refresh).not.toHaveBeenCalled();

		store.liveTitle = '';
		await nextTick();
		expect(refresh).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(15000);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(isPlaying.value).toBe(true);
	});

	it('stops with its scope', async () => {
		const { refresh, scope } = setup(true);
		await nextTick();
		const calls = refresh.mock.calls.length;

		scope.stop();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(refresh).toHaveBeenCalledTimes(calls);
	});
});
