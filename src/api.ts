import { useFetch } from '@/composables/fetch';
import type { Channel } from '@/types';

type ApiParams = Parameters<typeof useFetch>[0] & { baseUrl?: string };

const apiUrl = import.meta.env.VITE_SOMAFM_API_URL as string;

// Playlist and stream URLs come from the API response, so they are untrusted input:
// only SomaFM hosts are accepted and everything is forced to HTTPS (no mixed content).
const TRUSTED_HOST = /(?:^|\.)somafm\.com$/i;

function toTrustedHttpsUrl(rawUrl: string) {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error('Invalid URL received from the API');
	}
	if (!['http:', 'https:'].includes(url.protocol) || !TRUSTED_HOST.test(url.hostname)) {
		throw new Error(`Untrusted URL host: ${url.hostname}`);
	}
	url.protocol = 'https:';
	return url.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Minimal runtime check of what the app relies on; anything else from the API is dropped. */
function isChannel(value: unknown): value is Channel {
	if (!isRecord(value)) return false;
	const { id, title, playlists } = value;
	return (
		typeof id === 'string' &&
		typeof title === 'string' &&
		Array.isArray(playlists) &&
		playlists.every((playlist) => isRecord(playlist) && typeof playlist.url === 'string')
	);
}

function isSong(value: unknown): value is Channel['songs'][number] {
	return isRecord(value) && typeof value.title === 'string' && typeof value.artist === 'string';
}

async function useApi<T>({
	baseUrl = apiUrl,
	url,
	method,
	responseHandler,
	headers,
	body,
	signal,
}: ApiParams): Promise<T> {
	return await useFetch({
		url: baseUrl + url,
		method,
		responseHandler,
		headers,
		body,
		signal,
	});
}

export const api = {
	async getChannels(signal?: AbortSignal) {
		const response = await useApi<{ channels?: unknown }>({
			url: '/channels.json',
			method: 'get',
			signal,
		});
		if (!Array.isArray(response.channels)) throw new Error('Unexpected channels response');
		return response.channels.filter((channel) => isChannel(channel));
	},

	async getChannelSongs(channelId: string, signal?: AbortSignal) {
		const response = await useApi<{ songs?: unknown }>({
			url: `/songs/${encodeURIComponent(channelId)}.json`,
			method: 'get',
			signal,
		});
		if (!Array.isArray(response.songs)) throw new Error('Unexpected songs response');
		return response.songs.filter((song) => isSong(song));
	},

	async getStreamUrl(playlistUrl: string, signal?: AbortSignal) {
		const playlist: string = await useApi({
			baseUrl: '',
			url: toTrustedHttpsUrl(playlistUrl),
			method: 'get',
			responseHandler: 'text',
			signal,
		});
		const streamLine = playlist
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => /^(?:[^=]+=)?https?:\/\//.test(line));
		if (!streamLine) throw new Error('Stream URL not found in playlist');
		return toTrustedHttpsUrl(streamLine.slice(streamLine.search(/https?:\/\//)));
	},
};

export { isChannel };
