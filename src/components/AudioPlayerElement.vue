<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AudioPlayerElementControls from '@/components/AudioPlayerElementControls.vue';
import AudioPlayerElementVisualizer from '@/components/AudioPlayerElementVisualizer.vue';
import { useMediaSession } from '@/composables/media-session';
import { usePlayer } from '@/composables/player';
import { useSongRefresh } from '@/composables/song-refresh';
import { useMainStore } from '@/stores/main-store';

const props = defineProps<{ src: string }>();

const mainStore = useMainStore();
const audio = ref<HTMLAudioElement | null>(null);
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
	duck,
	listeners,
} = usePlayer(audio, { autoplay: computed(() => mainStore.autoplay) });

// The element is pointed at a new stream only after the old one was faded out, otherwise
// replacing a sounding stream cuts the waveform and clicks.
const currentSrc = ref(props.src);
watch(
	() => props.src,
	async (src) => {
		await duck();
		if (src === props.src) currentSrc.value = src;
	},
);

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
		<audio
			v-show="false"
			ref="audio"
			:autoplay="mainStore.autoplay"
			:preload="mainStore.autoplay ? 'auto' : 'none'"
			:src="currentSrc"
			crossorigin="anonymous"
			v-on="listeners"
		></audio>
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
