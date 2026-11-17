<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import AppTransition from '@/components/AppTransition.vue';
import AudioPlayer from '@/components/AudioPlayer.vue';
import ChannelList from '@/components/ChannelList.vue';
import MobileHeader from '@/components/MobileHeader.vue';
import PagePreloader from '@/components/PagePreloader.vue';
import ToggleChannelsButton from '@/components/ToggleChannelsButton.vue';
import { useScreenSize } from '@/composables/screen-size';
import { useMainStore } from '@/stores/main-store';

const mainStore = useMainStore();

const screenSize = useScreenSize();

let preloaderTimer: ReturnType<typeof setTimeout> | undefined;

function hidePagePreloader() {
	preloaderTimer = setTimeout(() => (mainStore.pageLoading = false), 500);
}

async function loadChannels() {
	mainStore.pageLoading = true;
	await mainStore.loadChannels();
	// Hide the preloader on failure too, otherwise the user is stuck on it forever.
	hidePagePreloader();
}

onMounted(loadChannels);
onUnmounted(() => clearTimeout(preloaderTimer));
</script>

<template>
	<div class="radio-container">
		<AppTransition name="fade">
			<PagePreloader v-if="mainStore.pageLoading" />
		</AppTransition>
		<div class="radio">
			<MobileHeader v-if="screenSize['max-width-sm']" />
			<ToggleChannelsButton v-if="screenSize['max-width-md']" />
			<div v-if="mainStore.channelsError" class="channels-error" role="alert">
				<p>Failed to load channels</p>
				<button type="button" @click="loadChannels">Retry</button>
			</div>
			<div class="player" :class="{ 'channels-open': mainStore.mobileChannelsOpen }">
				<ChannelList :data="mainStore.channels" />
				<AudioPlayer />
				<div
					v-if="screenSize['only-width-md']"
					class="mobile-overlay"
					@click="mainStore.mobileChannelsOpen = false"
				></div>
			</div>
		</div>
	</div>
</template>

<style scoped lang="scss">
.radio-container {
	display: flex;
	flex-wrap: wrap;
	place-content: center;
	height: 100dvh;
}

.channels-error {
	position: absolute;
	inset: 0;
	z-index: 30;
	display: flex;
	flex-direction: column;
	gap: 1rem;
	align-items: center;
	justify-content: center;
	color: $color-secondary-light-1;
	background: color-mix(in hsl, $color-primary-dark-2 90%, transparent);

	button {
		padding: 0.5rem 1.5rem;
		border: 0.0625rem solid currentcolor;
		border-radius: $border-radius;
		color: inherit;
		cursor: pointer;
	}
}

.radio {
	position: relative;

	@include media(max-width-sm) {
		overflow: hidden;
		width: 100%;
	}

	.player {
		position: relative;
		display: flex;
		place-content: center;
		gap: 1.25rem;
		height: 43.75rem;
		border-radius: $border-radius;
		transition: translate $transition-duration;

		@include media(max-width-lg) {
			height: 39.375rem;
		}

		@include media(max-width-md) {
			overflow: hidden;
			box-shadow: $box-shadow;
		}

		@include media(max-width-sm) {
			flex-direction: row-reverse;
			place-content: flex-start;
			gap: 0;
			overflow: visible;
			width: 100%;
			height: 100vh;
			padding: 3.625rem 0 0;
			border-radius: 0;
			box-shadow: none;
			translate: 100% 0;
		}

		.mobile-overlay {
			position: absolute;
			inset: 0;
			z-index: 19;
			background: color-mix(in hsl, hsl(0deg 0% 0%) 30%, transparent);
			opacity: 0;
			visibility: hidden;
			transition-property: opacity, visibility;
			transition-duration: $transition-duration;
		}

		&.channels-open {
			@include media(max-width-sm) {
				translate: 0;
			}

			.mobile-overlay {
				opacity: 1;
				visibility: visible;
			}
		}
	}
}
</style>
