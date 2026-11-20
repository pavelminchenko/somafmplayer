import { defineStore } from 'pinia';
import { api, isChannelSummary } from '@/api.ts';
import { splitArtistSong } from '@/lib/icy-demuxer';
import { type Channel, type ChannelSummary, type Song } from '@/types.ts';

const CHANNELS_CACHE_KEY = 'somafm-player:channels';
const LAST_CHANNEL_KEY = 'somafm-player:last-channel';

let channelRequest: AbortController | undefined;

function readCachedChannels(): ChannelSummary[] {
	try {
		const data: unknown = JSON.parse(localStorage.getItem(CHANNELS_CACHE_KEY) ?? '[]');
		return Array.isArray(data) ? data.filter((item) => isChannelSummary(item)) : [];
	} catch {
		return [];
	}
}

function writeCachedChannels(channels: ChannelSummary[]) {
	try {
		localStorage.setItem(CHANNELS_CACHE_KEY, JSON.stringify(channels));
	} catch {
		// Storage is full or unavailable (private mode): the cache is only an optimization.
	}
}

function readLastChannelId() {
	try {
		return localStorage.getItem(LAST_CHANNEL_KEY) ?? '';
	} catch {
		return '';
	}
}

function writeLastChannelId(id: string) {
	try {
		localStorage.setItem(LAST_CHANNEL_KEY, id);
	} catch {
		// Storage is full or unavailable (private mode): remembering the channel is optional.
	}
}

const MAX_TITLE_LENGTH = 300;

// [from, to] code point ranges that must not appear in a displayed title:
// controls, zero-width and direction marks (U+200B..U+200F), bidi overrides (U+202A..U+202E),
// bidi isolates (U+2066..U+2069) and the byte order mark (U+FEFF).
const STRIPPED_RANGES: [number, number][] = [
	[0, 31],
	[127, 159],
	[8203, 8207],
	[8234, 8238],
	[8294, 8297],
	[65279, 65279],
];

function isStrippable(code: number) {
	return STRIPPED_RANGES.some(([from, to]) => code >= from && code <= to);
}

/**
 * A title from the stream is untrusted text: drop control and bidi-override characters (they can
 * reorder what is displayed), squeeze whitespace and cap the length (the protocol allows 4 KB).
 */
function sanitizeTitle(raw: string) {
	const visible = Array.from(raw, (char) => (isStrippable(char.codePointAt(0) ?? 0) ? ' ' : char));
	const clean = visible.join('').split(/\s+/).filter(Boolean).join(' ');
	return clean.length > MAX_TITLE_LENGTH ? `${clean.slice(0, MAX_TITLE_LENGTH - 1)}…` : clean;
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export const useMainStore = defineStore('main-store', {
	state: () => ({
		pageLoading: true,
		mobileChannelsOpen: false,
		channels: [] as ChannelSummary[],
		channelsError: '',
		currentChannel: null as Channel | null,
		// Last channel the user asked for; differs from `currentChannel` while it loads or failed.
		requestedChannelId: '',
		channelLoading: false,
		channelError: '',
		// Mirror servers of the current channel's stream, in playlist order.
		streamUrls: [] as string[],
		// When the current channel's songs were last loaded (ms since epoch; 0 = never).
		songsUpdatedAt: 0,
		// Track title read from the stream itself (ICY), empty when the stream has none.
		liveTitle: '',
		// False for a channel restored after a reload: browsers block autoplay without a user gesture,
		// so it is prepared and waits for the Play button.
		autoplay: true,
	}),

	getters: {
		/**
		 * What is playing: the title from the stream when there is one (exact, in sync with the
		 * sound), otherwise the newest song of the API's history.
		 */
		nowPlaying(state): { artist: string; title: string } | null {
			if (state.liveTitle) {
				const { artist, song } = splitArtistSong(state.liveTitle);
				return { artist, title: song };
			}
			const songs = state.currentChannel?.songs;
			const song = songs && songs.length > 0 ? songs[0] : undefined;
			return song ? { artist: song.artist, title: song.title } : null;
		},
	},

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

			// Not awaited: the list is usable right away, the channel appears when it has loaded.
			const restore = this.restoreLastChannel();
			if (cached.length === 0) await restore;
		},

		/** Prepares the channel that was selected before the page was reloaded (without playing it). */
		async restoreLastChannel() {
			if (this.currentChannel || this.requestedChannelId) return; // the user already chose
			const id = readLastChannelId();
			const channel = this.channels.find((item) => item.id === id);
			if (!channel) return;

			await this.setCurrentChannel(channel, { autoplay: false });
			if (this.channelError && this.requestedChannelId === channel.id) {
				// A silent restore must not greet the user with an error.
				this.channelError = '';
				this.requestedChannelId = '';
			}
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

		async setCurrentChannel(channel: ChannelSummary, { autoplay = true } = {}) {
			const isCurrent = this.currentChannel?.id === channel.id && !this.channelError;
			// Already playing/loading this channel: nothing to do.
			if (this.requestedChannelId === channel.id && (isCurrent || this.channelLoading)) return;

			this.requestedChannelId = channel.id;
			if (isCurrent) {
				// Going back to the channel that is still playing: just cancel the pending switch.
				channelRequest?.abort();
				channelRequest = undefined;
				this.channelLoading = false;
				return;
			}

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

				const [streamUrls, songs] = await Promise.all([
					api.getStreamUrls(playlist.url, signal),
					// Song history is optional: playback must not depend on it.
					api.getChannelSongs(channel.id, signal).catch((error: unknown) => {
						if (signal.aborted) throw error;
						return [] as Song[];
					}),
				]);

				// A replaced request may still resolve (e.g. abort raced with the response body).
				if (signal.aborted) return;

				// Commit everything at once so the title, songs and stream never diverge.
				this.currentChannel = { ...channel, songs };
				this.liveTitle = ''; // a new channel: the previous stream's title does not apply
				this.songsUpdatedAt = Date.now();
				this.streamUrls = streamUrls;
				this.autoplay = autoplay;
				writeLastChannelId(channel.id);
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

		/** Stores the title read from the stream (sanitized); an empty string clears it. */
		setLiveTitle(raw: string) {
			this.liveTitle = sanitizeTitle(raw);
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
				if (this.currentChannel?.id === channel.id) {
					this.currentChannel.songs = songs;
					this.songsUpdatedAt = Date.now();
				}
			} catch {
				// Transient polling errors are ignored; the next tick retries.
			}
		},
	},
});
