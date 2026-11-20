<script setup lang="ts">
import { useDevicePixelRatio, useElementSize } from '@vueuse/core';
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { useScreenSize } from '@/composables/screen-size';
import type { AudioOutput } from '@/lib/audio-output';
import { Visualizer } from '@/lib/audio-visualizer';

const props = defineProps<{
	audio: HTMLAudioElement;
	output: AudioOutput;
}>();

const MIN_BITMAP_SIZE = 256;
// Resizing reallocates the canvas, so follow the window in coarse steps.
const BITMAP_STEP = 64;

const screenSize = useScreenSize();
// shallowRef: the instance is a plain class and must not be wrapped in a deep reactive proxy.
const visualizer = shallowRef<Visualizer>();
const visualizerElement = shallowRef<HTMLCanvasElement>();
// Logical drawing space (the picture is designed for it) ...
const size = computed(() => (screenSize['max-width-sm'] ? 1000 : 1500));
// ... and the canvas resolution: real on-screen pixels, never more than the logical size.
const { width: cssWidth } = useElementSize(visualizerElement);
const { pixelRatio } = useDevicePixelRatio();
const bitmapSize = computed(() => {
	if (cssWidth.value <= 0) return size.value;
	const pixels = Math.ceil((cssWidth.value * pixelRatio.value) / BITMAP_STEP) * BITMAP_STEP;
	return Math.min(size.value, Math.max(MIN_BITMAP_SIZE, pixels));
});

watch([size, bitmapSize], ([logical, bitmap]) => visualizer.value?.setSize(logical, bitmap));

onMounted(() => {
	if (!visualizerElement.value) return;
	visualizer.value = new Visualizer(props.audio, visualizerElement.value, props.output);
	visualizer.value.setSize(size.value, bitmapSize.value);
});

onBeforeUnmount(() => {
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
