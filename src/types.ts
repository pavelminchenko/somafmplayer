export interface Song {
	title: string;
	artist: string;
	album: string;
	albumArt: string;
	date: string;
}

/** A channel as listed by `channels.json` (no song history). */
export interface ChannelSummary {
	id: string;
	title: string;
	description: string;
	dj: string;
	djmail: string;
	genre: string;
	image: string;
	largeimage: string;
	xlimage: string;
	twitter: string;
	updated: string;
	playlists: { url: string; format: string; quality: string }[];
	preroll: unknown[];
	listeners: string;
	lastPlaying: string;
}

/** The channel being played: its summary plus the recently played songs. */
export interface Channel extends ChannelSummary {
	songs: Song[];
}
