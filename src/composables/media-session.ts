import { type MaybeRefOrGetter, onScopeDispose, toValue, watchEffect } from 'vue';
import { useMainStore } from '@/stores/main-store';

interface MediaSessionHandlers {
	play: () => void | Promise<void>;
	pause: () => void | Promise<void>;
	previous: () => void | Promise<void>;
	next: () => void | Promise<void>;
}

/** An empty title/artist (e.g. a stream without a proper title) falls back to something readable. */
function orFallback(value: string | undefined, fallback: string) {
	return value === undefined || value === '' ? fallback : value;
}

/**
 * Publishes the current channel/song and playback state to the OS (media keys, lock screen,
 * Bluetooth headsets, browser media hub) and routes their buttons to the player.
 */
export function useMediaSession(
	isPlaying: MaybeRefOrGetter<boolean>,
	handlers: MediaSessionHandlers,
) {
	if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

	const session = navigator.mediaSession;
	const mainStore = useMainStore();

	watchEffect(() => {
		const channel = mainStore.currentChannel;
		if (!channel) {
			session.metadata = null;
			return;
		}
		const song = mainStore.nowPlaying;
		const artwork = channel.xlimage || channel.largeimage || channel.image;
		session.metadata = new MediaMetadata({
			title: orFallback(song?.title, channel.title),
			artist: orFallback(song?.artist, 'SomaFM'),
			album: channel.title,
			artwork: artwork ? [{ src: artwork }] : [],
		});
	});

	watchEffect(() => {
		session.playbackState = toValue(isPlaying) ? 'playing' : 'paused';
	});

	const actions: [MediaSessionAction, () => void | Promise<void>][] = [
		['play', handlers.play],
		['pause', handlers.pause],
		['previoustrack', handlers.previous],
		['nexttrack', handlers.next],
	];
	for (const [action, handler] of actions) {
		try {
			// The browser ignores the return value; the handlers deal with their own errors.
			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			session.setActionHandler(action, handler);
		} catch {
			// The action is not supported by this browser.
		}
	}

	onScopeDispose(() => {
		for (const [action] of actions) {
			try {
				session.setActionHandler(action, null);
			} catch {
				// Same as above.
			}
		}
		session.metadata = null;
		session.playbackState = 'none';
	});
}
