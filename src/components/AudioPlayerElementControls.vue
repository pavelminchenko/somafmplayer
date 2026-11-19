<script setup lang="ts">
import { computed } from 'vue';
import { useMainStore } from '@/stores/main-store';

const props = defineProps<{
	isPlaying: boolean;
	volume: number;
}>();

const emit = defineEmits<{
	'update:playback': [value: boolean];
	'update:volume': [value: number];
}>();

const mainStore = useMainStore();

// Volume shown before muting, restored by the mute button.
let volumeBeforeMute = 1;
const isMuted = computed(() => props.volume === 0);

function updatePlayback() {
	emit('update:playback', props.isPlaying);
}

function toggleVolume() {
	if (isMuted.value) {
		emit('update:volume', volumeBeforeMute);
	} else {
		volumeBeforeMute = props.volume;
		emit('update:volume', 0);
	}
}

function controlVolume(event: Event) {
	const volume = Number((event.target as HTMLInputElement).value);
	if (volume > 0) volumeBeforeMute = volume;
	emit('update:volume', volume);
}
</script>

<template>
	<div class="audio-player-element-controls">
		<button
			type="button"
			class="playback-button"
			:class="props.isPlaying ? 'icon-pause' : 'icon-play'"
			@click="updatePlayback"
		>
			{{ props.isPlaying ? 'Pause' : 'Play' }}
		</button>
		<button
			type="button"
			class="icon-previous prev-button"
			@click="mainStore.selectAdjacentChannel(-1)"
		>
			Previous channel
		</button>
		<button type="button" class="icon-next next-button" @click="mainStore.selectAdjacentChannel(1)">
			Next channel
		</button>
		<div class="volume">
			<button
				type="button"
				class="mute-button"
				:class="isMuted ? 'icon-mute' : 'icon-volume'"
				@click="toggleVolume"
			>
				{{ isMuted ? 'Unmute' : 'Mute' }}
			</button>
			<div class="volumebar" :style="{ backgroundSize: `${props.volume * 100}% 100%` }">
				<input
					type="range"
					aria-label="Volume"
					min="0"
					max="1"
					step="0.01"
					:value="props.volume"
					@input="controlVolume"
				/>
			</div>
		</div>
	</div>
</template>

<style scoped lang="scss">
.audio-player-element-controls {
	display: flex;
	justify-content: center;
	align-items: center;
	gap: 1.25rem;
	width: 100%;

	@include media(max-width-sm) {
		bottom: 4.375rem;
		left: 0.625rem;
		gap: 0.625rem;
	}
}

.playback-button,
.prev-button,
.next-button,
.mute-button {
	width: var(--size);
	height: var(--size);
	font-size: 0;

	&::before {
		width: var(--size);
		height: var(--size);
		font-size: var(--size);
		color: $color-secondary-dark-2;
		background-color: $color-primary-dark-2;
		border-radius: 100%;
	}

	@include hover {
		&::before {
			background-color: $color-primary-dark-1;
		}
	}
}

.playback-button {
	--size: 10rem;

	@include media(max-width-sm) {
		--size: 7.5rem;
	}

	position: absolute;
	top: 50%;
	left: 50%;
	z-index: 10;
	translate: -50% -50%;
}

.prev-button,
.next-button {
	--size: 3.75rem;

	@include media(max-width-sm) {
		--size: 2.5rem;
	}

	position: relative;
	z-index: 10;
}

.volume {
	position: relative;
	z-index: 10;
	display: flex;
	align-items: center;
	gap: 0.625rem;

	.mute-button {
		--size: 2.1875rem;

		@include media(max-width-sm) {
			--size: 1.75rem;
		}
	}

	.volumebar {
		position: relative;
		width: 5rem;
		height: 1rem;
		background-color: $color-primary-light-1;
		background-image: linear-gradient(0deg, $color-primary-dark-2, $color-primary-dark-2);
		background-repeat: no-repeat;
		border: 0.125rem solid $color-secondary-dark-1;
		border-radius: $border-radius;
		cursor: pointer;

		@include hover {
			background-image: linear-gradient(0deg, $color-primary-dark-1, $color-primary-dark-1);
		}

		@include media(max-width-sm) {
			height: 0.875rem;
		}

		input {
			position: absolute;
			inset: -0.125rem;
			opacity: 0;
			cursor: inherit;
		}
	}
}
</style>
