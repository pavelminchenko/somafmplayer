<script setup lang="ts">
import { useDevicePixelRatio, useElementSize } from '@vueuse/core';
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { useScreenSize } from '@/composables/screen-size';
import { Visualizer } from '@/lib/audio-visualizer';

const props = defineProps<{
	audio: HTMLAudioElement;
}>();

const MIN_BITMAP_SIZE = 256;

const screenSize = useScreenSize();
// shallowRef: the instance is a plain class and must not be wrapped in a deep reactive proxy.
const visualizer = shallowRef<Visualizer>();
const visualizerElement = shallowRef<HTMLCanvasElement>();
// Logical drawing space (the picture is designed for it) ...
const size = computed(() => (screenSize['max-width-sm'] ? 1000 : 1500));
// ... and the canvas resolution: real on-screen pixels, never more than the logical size.
const { width: cssWidth } = useElementSize(visualizerElement);
const { pixelRatio } = useDevicePixelRatio();
const bitmapSize = computed(() =>
	cssWidth.value > 0
		? Math.min(size.value, Math.max(MIN_BITMAP_SIZE, Math.ceil(cssWidth.value * pixelRatio.value)))
		: size.value,
);

const resumeContext = () => visualizer.value?.resume();

watch([size, bitmapSize], ([logical, bitmap]) => visualizer.value?.setSize(logical, bitmap));

onMounted(() => {
	if (!visualizerElement.value) return;
	visualizer.value = new Visualizer(props.audio, visualizerElement.value);
	visualizer.value.setSize(size.value, bitmapSize.value);
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
