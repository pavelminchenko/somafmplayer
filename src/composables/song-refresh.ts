import { useDocumentVisibility, useIntervalFn } from '@vueuse/core';
import { computed, type MaybeRefOrGetter, toValue, watch } from 'vue';
import { useMainStore } from '@/stores/main-store';

const SONGS_REFRESH_INTERVAL_MS = 15000;
// The songs were just loaded together with the channel: no need to ask again right away.
const FRESH_FOR_MS = 5000;

/**
 * Keeps the "now playing" song up to date. The SomaFM API has no push channel, so this polls,
 * but only while it matters (sound is wanted and the tab is visible), and it refreshes at once
 * when it starts mattering again (Play pressed, tab shown, reconnected), so a returning
 * listener does not look at a stale title until the next tick.
 */
export function useSongRefresh(isPlaying: MaybeRefOrGetter<boolean>) {
	const mainStore = useMainStore();
	const visibility = useDocumentVisibility();
	async function refresh() {
		await mainStore.refreshCurrentSongs();
	}

	// The tick's promise never rejects (refreshCurrentSongs swallows transient errors).
	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	const { pause, resume } = useIntervalFn(refresh, SONGS_REFRESH_INTERVAL_MS, { immediate: false });
	const isActive = computed(() => toValue(isPlaying) && visibility.value === 'visible');

	watch(
		isActive,
		async (active) => {
			if (!active) {
				pause();
				return;
			}
			resume();
			if (Date.now() - mainStore.songsUpdatedAt > FRESH_FOR_MS) await refresh();
		},
		{ immediate: true },
	);
}
