import { defineStore } from 'pinia';
import { api } from '@/api.ts';
import { type Channel } from '@/types.ts';

let channelRequest: AbortController | undefined;

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export const useMainStore = defineStore('main-store', {
	state: () => ({
		pageLoading: true,
		mobileChannelsOpen: false,
		channels: [] as Channel[],
		channelsError: '',
		currentChannel: null as Channel | null,
		// Last channel the user asked for; differs from `currentChannel` while it loads or failed.
		requestedChannelId: '',
		channelLoading: false,
		channelError: '',
		streamUrl: '',
	}),

	actions: {
		async loadChannels() {
			this.channelsError = '';
			try {
				this.channels = await api.getChannels();
			} catch (error) {
				this.channelsError = getErrorMessage(error);
			}
		},

		async setCurrentChannel(channel: Channel) {
			if (this.currentChannel?.id === channel.id && !this.channelError) return;

			this.requestedChannelId = channel.id;

			// Cancel the previous request so a slow response can't overwrite a newer choice.
			channelRequest?.abort();
			const request = new AbortController();
			channelRequest = request;
			const { signal } = request;

			this.channelLoading = true;
			this.channelError = '';

			try {
				if (channel.playlists.length === 0) {
					throw new Error(`Channel "${channel.title}" has no playlists`);
				}
				const [playlist] = channel.playlists;

				const [streamUrl, songs] = await Promise.all([
					api.getStreamUrl(playlist.url, signal),
					// Song history is optional: playback must not depend on it.
					api.getChannelSongs(channel.id, signal).catch((error: unknown) => {
						if (signal.aborted) throw error;
						return [] as Channel['songs'];
					}),
				]);

				// A replaced request may still resolve (e.g. abort raced with the response body).
				if (signal.aborted) return;

				// Commit everything at once so the title, songs and stream never diverge.
				this.currentChannel = { ...channel, songs };
				this.streamUrl = streamUrl;
			} catch (error) {
				if (signal.aborted) return;
				this.channelError = getErrorMessage(error);
			} finally {
				if (channelRequest === request) {
					channelRequest = undefined;
					this.channelLoading = false;
				}
			}
		},

		/** Switches to the previous (-1) or next (1) channel in list order. */
		async selectAdjacentChannel(step: -1 | 1) {
			// Based on the last request so quick repeated clicks keep moving instead of retrying one target.
			const fromId = this.requestedChannelId || this.currentChannel?.id;
			const index = this.channels.findIndex(({ id }) => id === fromId);
			const target = index === -1 ? undefined : this.channels[index + step];
			if (target) await this.setCurrentChannel(target);
		},

		async refreshCurrentSongs() {
			const channel = this.currentChannel;
			if (!channel) return;
			try {
				const songs = await api.getChannelSongs(channel.id);
				// The user may have switched channels while the request was in flight.
				if (this.currentChannel?.id === channel.id) this.currentChannel.songs = songs;
			} catch {
				// Transient polling errors are ignored; the next tick retries.
			}
		},
	},
});
