<script setup lang="ts">
import { computed, ref } from 'vue';
import AudioPlayerElementControls from '@/components/AudioPlayerElementControls.vue';
import AudioPlayerElementVisualizer from '@/components/AudioPlayerElementVisualizer.vue';
import { useMediaSession } from '@/composables/media-session';
import { usePlayer } from '@/composables/player';
import { useSongRefresh } from '@/composables/song-refresh';
import { useMainStore } from '@/stores/main-store';

const mainStore = useMainStore();
const audio = ref<HTMLAudioElement | null>(null);
// The player owns the element's source: it picks the mirror server, fails over to the next one
// when the connection drops and fades the sound out before a new stream replaces the old one.
const {
	output,
	isPlaying,
	statusMessage,
	errorMessage,
	volume,
	setVolume,
	resume,
	pause,
	toggle,
	listeners,
} = usePlayer(audio, {
	sources: computed(() => mainStore.streamUrls),
	autoplay: computed(() => mainStore.autoplay),
});

useSongRefresh(isPlaying);
useMediaSession(isPlaying, {
	play: resume,
	pause,
	previous: () => mainStore.selectAdjacentChannel(-1),
	next: () => mainStore.selectAdjacentChannel(1),
});
</script>

<template>
	<div class="audio-player-element">
		<audio v-show="false" ref="audio" crossorigin="anonymous" v-on="listeners"></audio>
		<p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
		<p v-else-if="statusMessage" class="status" role="status">{{ statusMessage }}</p>
		<AudioPlayerElementControls
			:is-playing="isPlaying"
			:volume="volume"
			@update:playback="toggle"
			@update:volume="setVolume"
		/>
		<AudioPlayerElementVisualizer v-if="audio && output" :audio="audio" :output="output" />
	</div>
</template>

<style scoped lang="scss">
.status,
.error {
	position: relative;
	z-index: 1;
	margin-bottom: 0.625rem;
	text-align: center;
}

.error {
	color: $color-tertiary;
}

.status {
	color: $color-secondary;
}
</style>
