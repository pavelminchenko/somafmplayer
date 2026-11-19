<script setup lang="ts">
import { ref } from 'vue';
import AudioPlayerElementControls from '@/components/AudioPlayerElementControls.vue';
import AudioPlayerElementVisualizer from '@/components/AudioPlayerElementVisualizer.vue';
import { useMediaSession } from '@/composables/media-session';
import { usePlayer } from '@/composables/player';
import { useMainStore } from '@/stores/main-store';

const props = defineProps<{ src: string }>();

const audio = ref<HTMLAudioElement | null>(null);
const { isPlaying, isWaiting, errorMessage, volume, setVolume, resume, pause, toggle, listeners } =
	usePlayer(audio);

const mainStore = useMainStore();
useMediaSession(isPlaying, {
	play: resume,
	pause,
	previous: () => mainStore.selectAdjacentChannel(-1),
	next: () => mainStore.selectAdjacentChannel(1),
});
</script>

<template>
	<div class="audio-player-element" :class="{ waiting: isWaiting }">
		<audio
			v-show="false"
			ref="audio"
			:src="props.src"
			autoplay
			crossorigin="anonymous"
			v-on="listeners"
		></audio>
		<p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
		<p v-else-if="isWaiting" class="status" role="status">Buffering…</p>
		<AudioPlayerElementControls
			:is-playing="isPlaying"
			:volume="volume"
			@update:playback="toggle"
			@update:volume="setVolume"
		/>
		<AudioPlayerElementVisualizer v-if="audio" :audio="audio" />
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
