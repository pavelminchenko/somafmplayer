import { type Ref } from 'vue';
import type { LostReason } from '@/lib/mse-stream';
import {
	createElementTransport,
	createMseTransport,
	readTransportPreference,
	type StreamTransport,
	type TransportCallbacks,
	type TransportKind,
} from '@/lib/stream-transport';

interface StreamSourceOptions {
	getElement: () => HTMLAudioElement | null;
	/** Mirror servers of the current channel's stream (the first one is tried first). */
	sources?: Ref<string[]>;
	/** How the stream reaches the element; defaults to the user's choice (`?transport=`). */
	transport?: TransportKind;
	/** Replaces the MSE transport (tests). */
	createMseTransport?: (callbacks: TransportCallbacks) => StreamTransport;
	callbacks: TransportCallbacks;
}

/**
 * Where the stream comes from: which mirror server is in use, how it is fetched (the proven
 * `<audio src>` path or MSE with titles) and the fallback from one to the other.
 *
 * A channel where MSE fails falls back to the element for that channel only; MSE being
 * unsupported altogether switches the preference for good.
 */
function createStreamSource(options: StreamSourceOptions) {
	let preferredKind: TransportKind = options.transport ?? readTransportPreference();
	let mirrorIndex = 0;
	let currentSource = '';
	let mseEverPlayed = false;

	function createTransport(kind: TransportKind): StreamTransport {
		return kind === 'mse'
			? (options.createMseTransport?.(options.callbacks) ??
					createMseTransport(options.getElement, options.callbacks))
			: createElementTransport(options.getElement);
	}
	let transport = createTransport(preferredKind);

	/** Connects to `url`: a new URL opens a new connection, the same URL reconnects. */
	function setSource(url: string, startNow = true) {
		if (currentSource === url) {
			transport.reopen();
			return;
		}
		currentSource = url;
		transport.open(url, startNow);
	}

	/** A (new) channel: forget the previous stream's state and open its primary server. */
	function openChannel(urls: string[], startNow: boolean) {
		mseEverPlayed = false;
		if (transport.kind !== preferredKind) {
			transport.close();
			transport = createTransport(preferredKind);
		}
		mirrorIndex = 0;
		setSource(urls[0], startNow);
	}

	/** Restarts the stream, optionally on the next mirror (all of them serve the same channel). */
	function reload({ nextMirror }: { nextMirror: boolean }) {
		const urls = options.sources?.value ?? [];
		if (urls.length === 0) {
			transport.reopen(); // no source management: reload whatever is set
			return;
		}
		if (nextMirror) mirrorIndex = (mirrorIndex + 1) % urls.length;
		setSource(urls[mirrorIndex] ?? urls[0]);
	}

	/** Every attempt failed: start over with the primary server. */
	function restartFromPrimary() {
		mirrorIndex = 0;
		reload({ nextMirror: false });
	}

	/**
	 * Gives up on MSE for this channel and switches to the plain element. Returns whether there is
	 * a stream URL to continue with (the caller then opens it with `openCurrent`).
	 */
	function fallbackToElement(reason?: LostReason) {
		if (reason === 'unsupported') preferredKind = 'element'; // it will never work here
		transport.close();
		transport = createElementTransport(options.getElement);
		return currentSource !== '';
	}

	return {
		/** `true` while MSE is in use but has not produced any sound for this channel yet. */
		isMseWithoutSound: () => transport.kind === 'mse' && !mseEverPlayed,
		/** Remembers that MSE works for this channel (later drops are ordinary outages). */
		markPlayed() {
			if (transport.kind === 'mse') mseEverPlayed = true;
		},
		hasSource: () => currentSource !== '',
		openChannel,
		/** Re-attaches the current URL (after a fallback); `startNow = false` only prepares it. */
		openCurrent: (startNow: boolean) => {
			transport.open(currentSource, startNow);
		},
		reload,
		restartFromPrimary,
		fallbackToElement,
		/** Begins connecting if the channel was only prepared (restored after a reload). */
		start: () => {
			transport.start();
		},
		close: () => {
			transport.close();
		},
	};
}

export { createStreamSource };
