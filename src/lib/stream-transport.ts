/**
 * How a stream URL gets into the <audio> element.
 *
 * - `element`: the browser plays the URL itself (`audio.src = url`). Simple and proven, no track
 *   titles from the stream.
 * - `mse`: our own reader (see mse-stream.ts) feeds the element through MediaSource, which also
 *   gives us the ICY track titles with a single connection.
 *
 * `usePlayer` owns the state machine (reconnects, mirrors, watchdog); a transport only knows how
 * to start, restart and release one connection.
 */

import { type LostReason, type MseStream, startMseStream } from '@/lib/mse-stream';

type TransportKind = 'element' | 'mse';

interface TransportCallbacks {
	/** A track title read from the stream, at the moment the sound reaches it. */
	onTitle: (title: string) => void;
	/** The connection is gone (the transport cannot recover by itself). */
	onLost: (reason: LostReason, detail?: string) => void;
	/** The connection was dropped on purpose after a long pause. */
	onSuspended: () => void;
}

interface StreamTransport {
	readonly kind: TransportKind;
	/**
	 * Attaches the stream at `url`. With `startNow = false` it is only prepared: no connection is
	 * made until `start()` (e.g. a channel restored after a reload waits for the Play button).
	 */
	open: (url: string, startNow: boolean) => void;
	/** A fresh connection to the same URL (after an error or a long pause). */
	reopen: () => void;
	/** Begins connecting if `open(url, false)` deferred it; a no-op otherwise. */
	start: () => void;
	/** Releases the connection and everything attached to it. Safe to call twice. */
	close: () => void;
}

type ElementGetter = () => HTMLAudioElement | null;

function createElementTransport(getElement: ElementGetter): StreamTransport {
	return {
		kind: 'element',
		open(url, startNow) {
			const element = getElement();
			if (!element) return;
			// Must be set before `src`: they decide whether loading starts and whether it autoplays.
			element.autoplay = startNow;
			element.preload = startNow ? 'auto' : 'none';
			element.src = url;
		},
		reopen() {
			getElement()?.load();
		},
		start() {
			// The element starts loading by itself (autoplay / play()).
		},
		close() {
			// Nothing of ours is attached to the element.
		},
	};
}

interface MseTransportDeps {
	/** Replaceable for tests. */
	start?: typeof startMseStream;
}

function createMseTransport(
	getElement: ElementGetter,
	callbacks: TransportCallbacks,
	deps: MseTransportDeps = {},
): StreamTransport {
	const start = deps.start ?? startMseStream;
	let url = '';
	let stream: MseStream | undefined;

	function release() {
		stream?.stop();
		stream = undefined;
	}

	function begin() {
		const element = getElement();
		if (!element || !url) return;
		release();
		element.autoplay = true;
		stream = start(element, url, {
			onTitle: callbacks.onTitle,
			onLost: callbacks.onLost,
			onSuspended: callbacks.onSuspended,
		});
	}

	return {
		kind: 'mse',
		open(nextUrl, startNow) {
			release();
			url = nextUrl;
			if (startNow) {
				begin();
				return;
			}
			const element = getElement();
			if (element) element.autoplay = false;
		},
		reopen() {
			begin();
		},
		start() {
			if (!stream) begin();
		},
		close() {
			release();
		},
	};
}

/**
 * Which transport to use. MSE (track titles from the stream) is the default wherever the standard
 * MediaSource can play MP3; `?transport=audio` turns it off (remembered), `?transport=mse` turns
 * it back on. Everywhere else, and outside a browser, the proven `<audio src>` path is used.
 */
const TRANSPORT_KEY = 'somafm-player:transport';

function mseAvailable() {
	const { MediaSource: Source } = globalThis as { MediaSource?: typeof MediaSource };
	return Source?.isTypeSupported('audio/mpeg') ?? false;
}

function readTransportPreference(): TransportKind {
	try {
		const requested = new URLSearchParams(globalThis.location.search).get('transport');
		if (requested === 'mse' || requested === 'audio') {
			localStorage.setItem(TRANSPORT_KEY, requested);
		}
		const choice = requested ?? localStorage.getItem(TRANSPORT_KEY);
		if (choice === 'audio') return 'element';
		return mseAvailable() ? 'mse' : 'element';
	} catch {
		return 'element'; // no location / storage (tests, private mode)
	}
}

export { createElementTransport, createMseTransport, readTransportPreference };
export type { StreamTransport, TransportCallbacks, TransportKind };
