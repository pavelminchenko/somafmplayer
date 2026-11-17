<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { useScreenSize } from '@/composables/screen-size';
// @ts-expect-error audio-visualizer
import { Visualizer } from '@/lib/audio-visualizer';

interface VisualizerInstance {
	/* eslint-disable-next-line no-unused-vars, no-shadow */
	setSize: (width: number, height: number) => void;
	resume: () => void;
	destroy: () => void;
}

const props = defineProps<{
	audio: HTMLAudioElement;
}>();

const screenSize = useScreenSize();
// shallowRef: the instance is a plain class and must not be wrapped in a deep reactive proxy.
const visualizer = shallowRef<VisualizerInstance>();
const visualizerElement = shallowRef<HTMLCanvasElement>();
const size = computed(() => (screenSize['max-width-sm'].value ? 1000 : 1500));

const resumeContext = () => visualizer.value?.resume();

watch(size, (value) => visualizer.value?.setSize(value, value));

onMounted(() => {
	if (!visualizerElement.value) return;
	visualizer.value = new Visualizer(props.audio, visualizerElement.value) as VisualizerInstance;
	visualizer.value.setSize(size.value, size.value);
	// Browsers may keep the AudioContext suspended until the user starts playback.
	props.audio.addEventListener('play', resumeContext);
});

onBeforeUnmount(() => {
	props.audio.removeEventListener('play', resumeContext);
	visualizer.value?.destroy();
	visualizer.value = undefined;
});
</script>

<template>
	<canvas ref="visualizerElement" class="audio-player-element-visualizer" />
</template>

<style scoped lang="scss">
.audio-player-element-visualizer {
	position: absolute;
	top: 0;
	left: 0;
	z-index: 0;
	width: 100%;
	height: 100%;
	opacity: 0.7;

	@include media(max-width-sm) {
		top: 50%;
		left: 50%;
		width: 100vw;
		height: 100vw;
		translate: -50% -50%;
	}
}
</style>
