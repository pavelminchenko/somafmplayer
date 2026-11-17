<script setup lang="ts">
import { ref } from 'vue';
import AudioPlayerElementControls from '@/components/AudioPlayerElementControls.vue';
import AudioPlayerElementVisualizer from '@/components/AudioPlayerElementVisualizer.vue';

const props = defineProps<{ src: string }>();

const audio = ref<HTMLAudioElement | null>(null);
const isPlaying = ref(false);
const isWaiting = ref(false);
const volume = ref(1);
const errorMessage = ref('');
// Set when the user pauses on purpose, so `canplay` doesn't resume playback behind their back.
let pausedByUser = false;

const mediaErrorMessages: Record<number, string> = {
	[MediaError.MEDIA_ERR_NETWORK]: 'Network error while loading the stream',
	[MediaError.MEDIA_ERR_DECODE]: 'The stream could not be decoded',
	[MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: 'The stream is unavailable or not supported',
};

async function play() {
	if (!audio.value) return;
	try {
		await audio.value.play();
	} catch (error) {
		// AbortError: play() was interrupted by a new load/pause, which is expected.
		if (error instanceof DOMException && error.name === 'AbortError') return;
		isPlaying.value = false;
		errorMessage.value =
			error instanceof DOMException && error.name === 'NotAllowedError'
				? 'Playback was blocked by the browser. Press play to start.'
				: 'Unable to start playback';
	}
}

async function updatePlayback(isCurrentlyPlaying: boolean) {
	if (!audio.value) return;
	pausedByUser = isCurrentlyPlaying;
	if (isCurrentlyPlaying) {
		audio.value.pause();
	} else {
		errorMessage.value = '';
		await play();
	}
}

function updateVolume(value: number) {
	if (audio.value) audio.value.volume = value;
	volume.value = value;
}

const eventListeners = {
	loadstart() {
		isPlaying.value = false;
		isWaiting.value = true;
		errorMessage.value = '';
		pausedByUser = false;
	},

	async canplay() {
		isWaiting.value = false;
		if (!pausedByUser && audio.value?.paused) await play();
	},

	playing() {
		isWaiting.value = false;
	},

	play() {
		isPlaying.value = true;
	},

	pause() {
		isPlaying.value = false;
	},

	waiting() {
		isWaiting.value = true;
	},

	ended() {
		isPlaying.value = false;
		isWaiting.value = false;
	},

	error(event: Event) {
		isPlaying.value = false;
		isWaiting.value = false;
		const code = (event.target as HTMLAudioElement).error?.code;
		errorMessage.value = (code && mediaErrorMessages[code]) || 'Playback error';
	},
};
</script>

<template>
	<div class="audio-player-element" :class="{ waiting: isWaiting }">
		<audio
			v-show="false"
			ref="audio"
			:src="props.src"
			autoplay
			crossorigin="anonymous"
			v-on="eventListeners"
		></audio>
		<p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
		<AudioPlayerElementControls
			:is-playing="isPlaying"
			:volume="volume"
			@update:playback="updatePlayback"
			@update:volume="updateVolume"
		/>
		<AudioPlayerElementVisualizer v-if="audio" :audio="audio" />
	</div>
</template>

<style scoped lang="scss">
.error {
	position: relative;
	z-index: 1;
	margin-bottom: 0.625rem;
	text-align: center;
	color: $color-tertiary;
}
</style>
