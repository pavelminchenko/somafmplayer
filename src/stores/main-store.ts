import { defineStore } from 'pinia';
import { api } from '@/api.ts';
import { type Channel } from '@/types.ts';

const CHANNELS_CACHE_KEY = 'somafm-player:channels';

let channelRequest: AbortController | undefined;

function isChannel(value: unknown): value is Channel {
	if (typeof value !== 'object' || value === null) return false;
	const { id, title, playlists } = value as Partial<Channel>;
	return typeof id === 'string' && typeof title === 'string' && Array.isArray(playlists);
}

function readCachedChannels(): Channel[] {
	try {
		const data: unknown = JSON.parse(localStorage.getItem(CHANNELS_CACHE_KEY) ?? '[]');
		return Array.isArray(data) ? data.filter((item) => isChannel(item)) : [];
	} catch {
		return [];
	}
}

function writeCachedChannels(channels: Channel[]) {
	try {
		localStorage.setItem(CHANNELS_CACHE_KEY, JSON.stringify(channels));
	} catch {
		// Storage is full or unavailable (private mode): the cache is only an optimization.
	}
}

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
		/**
		 * Stale-while-revalidate: with a cached list the UI is ready immediately and the fresh
		 * list replaces it in the background; without a cache this waits for the network.
		 */
		async loadChannels() {
			this.channelsError = '';
			const cached = this.channels.length === 0 ? readCachedChannels() : [];
			if (cached.length > 0) this.channels = cached;

			const refresh = this.refreshChannels();
			if (cached.length === 0) await refresh;
		},

		async refreshChannels() {
			try {
				const channels = await api.getChannels();
				this.channels = channels;
				writeCachedChannels(channels);
			} catch (error) {
				// A stale list is better than an error screen.
				if (this.channels.length === 0) this.channelsError = getErrorMessage(error);
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
