<script setup lang="ts">
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core';
import { computed } from 'vue';
import { useMainStore } from '@/stores/main-store';

const SONGS_REFRESH_INTERVAL = 15000;

const mainStore = useMainStore();
const visibility = useDocumentVisibility();

const currentSongInfo = computed(() => {
	const song = mainStore.currentChannel?.songs[0];
	return song ? `${song.artist} - ${song.title}` : '';
});

// Stopped automatically on unmount; skipped while the tab is hidden.
useIntervalFn(async () => {
	if (visibility.value === 'visible') await mainStore.refreshCurrentSongs();
}, SONGS_REFRESH_INTERVAL);
</script>

<template>
	<div class="audio-player-channel-info">
		<div class="title">{{ mainStore.currentChannel!.title }}</div>
		<div class="genre">{{ mainStore.currentChannel!.genre }}</div>
		<div class="description">{{ mainStore.currentChannel!.description }}</div>
		<div class="current-song">{{ currentSongInfo }}</div>
	</div>
</template>

<style scoped lang="scss">
.audio-player-channel-info {
	position: relative;
	z-index: 1;
	display: flex;
	flex-direction: column;
	height: 100%;
	padding-bottom: 1.875rem;

	.title {
		padding: 0 0 0.3125rem;
		font-size: $font-size-lg;
		color: hsl(0deg 0% 100%);
	}

	.genre {
		padding: 0 0 0.5rem;
		font-size: $font-size-sm;
		color: $color-tertiary;
	}

	.description {
		font-size: $font-size-md;
		color: $color-secondary;

		@include media(max-width-lg) {
			font-size: $font-size-sm;
		}
	}

	.current-song {
		width: 100%;
		margin-top: auto;
		font-size: $font-size-md;
		text-align: center;
		color: hsl(0deg 0% 100%);

		@include media(max-width-lg) {
			font-size: $font-size-sm;
		}
	}
}
</style>
