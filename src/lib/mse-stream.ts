/**
 * Plays a live Icecast/Shoutcast MP3 stream through MediaSource while reading its ICY metadata.
 *
 * One `fetch` (with `Icy-MetaData: 1`) feeds both: audio bytes go to a SourceBuffer behind the
 * <audio> element, `StreamTitle` blocks are cut out and reported when the sound reaches them.
 * The element keeps working as a normal player (events, GainNode, Media Session, ...).
 *
 * Verified in the browser by `tools/icy-mse-spike.html`; this is the production version with
 * back-pressure, buffer trimming, live-edge resync and an idle disconnect on pause.
 */

import { createIcyDemuxer } from '@/lib/icy-demuxer';

const MIME_TYPE = 'audio/mpeg';

type LostReason =
	| 'unsupported' // no MediaSource / MP3 in MSE
	| 'http' // the server answered with an error status
	| 'network' // the connection failed or was reset while reading
	| 'ended' // the server closed the stream (a live stream never ends)
	| 'decode' // the SourceBuffer rejected the data
	| 'quota'; // the buffer could not be trimmed enough to fit new data

interface MseStreamHandlers {
	/** A track title (`StreamTitle`), at the moment the sound reaches it. */
	onTitle?: (title: string) => void;
	/** The stream is gone for `reason` (once); the owner decides how to recover. */
	onLost?: (reason: LostReason, detail?: string) => void;
	/** The element was paused long enough that the connection was dropped to save bandwidth. */
	onSuspended?: () => void;
}

interface MseStreamOptions {
	/** Keep this much already played audio, trim everything older. */
	keepBehindSeconds: number;
	/** If buffered audio is further ahead than this while playing, jump toward the live edge. */
	maxAheadSeconds: number;
	/** Distance from the live edge to jump to. */
	liveMarginSeconds: number;
	/** Network chunks are merged into appends of at least this many bytes ... */
	batchBytes: number;
	/** ... or after this long. */
	batchMs: number;
	/** Stop reading while this many bytes wait to be appended (back-pressure). */
	maxQueueBytes: number;
	/** Drop the connection after the element was paused for this long. */
	idleDisconnectMs: number;
}

const DEFAULT_OPTIONS: MseStreamOptions = {
	keepBehindSeconds: 15,
	maxAheadSeconds: 25,
	liveMarginSeconds: 4,
	batchBytes: 32 * 1024,
	batchMs: 300,
	maxQueueBytes: 512 * 1024,
	idleDisconnectMs: 20000,
};

/** Browser APIs, injectable for tests. */
interface MseStreamDeps {
	MediaSource?: typeof MediaSource;
	fetch?: typeof fetch;
	createObjectURL?: (source: MediaSource) => string;
	revokeObjectURL?: (url: string) => void;
}

interface MseStreamStats {
	bytesAppended: number;
	appends: number;
	trims: number;
	liveEdgeJumps: number;
	queuedBytes: number;
}

interface MseStream {
	/** Stops everything and releases resources; no callbacks after this. Safe to call twice. */
	stop: () => void;
	/** Settles when reading has ended (stopped, lost or suspended). */
	done: Promise<void>;
	stats: () => MseStreamStats;
}

interface TitleMarker {
	title: string;
	/** Media time at which the title starts (filled in once the audio before it is appended). */
	mediaTime: number;
}

type QueueItem = { data: Uint8Array } | { marker: TitleMarker };

function resolveMediaSource(deps: MseStreamDeps) {
	if (deps.MediaSource) return deps.MediaSource;
	// iOS 17.1+ only offers the "managed" variant.
	const scope = globalThis as unknown as {
		ManagedMediaSource?: typeof MediaSource;
		MediaSource?: typeof MediaSource;
	};
	return scope.ManagedMediaSource ?? scope.MediaSource;
}

function startMseStream(
	audio: HTMLAudioElement,
	url: string,
	handlers: MseStreamHandlers = {},
	partialOptions: Partial<MseStreamOptions> = {},
	deps: MseStreamDeps = {},
): MseStream {
	const options = { ...DEFAULT_OPTIONS, ...partialOptions };
	const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
	const createObjectURL = deps.createObjectURL ?? ((source) => URL.createObjectURL(source));
	const revokeObjectURL =
		deps.revokeObjectURL ??
		((value) => {
			URL.revokeObjectURL(value);
		});

	const abort = new AbortController();
	const counters = { bytesAppended: 0, appends: 0, trims: 0, liveEdgeJumps: 0 };
	let stopped = false;
	const isStopped = () => stopped;
	let lostReported = false;
	let objectUrl = '';
	let mediaSource: MediaSource | undefined;
	let sourceBuffer: SourceBuffer | undefined;
	const isUpdating = () => sourceBuffer?.updating ?? false;

	let queue: QueueItem[] = [];
	let queuedBytes = 0;
	let batch: Uint8Array[] = [];
	let batchSize = 0;
	let batchTimer: ReturnType<typeof setTimeout> | undefined;
	let drainWaiters: (() => void)[] = [];
	let timeline: TitleMarker[] = [];
	let firstTitleSeen = false;
	let quotaRetried = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	function lost(reason: LostReason, detail?: string) {
		if (stopped || lostReported) return;
		lostReported = true;
		handlers.onLost?.(reason, detail);
	}

	function releaseDrainWaiters() {
		const waiters = drainWaiters;
		drainWaiters = [];
		for (const resolve of waiters) resolve();
	}

	function bufferedStart() {
		return sourceBuffer && sourceBuffer.buffered.length > 0 ? sourceBuffer.buffered.start(0) : 0;
	}

	function bufferedEnd() {
		const ranges = sourceBuffer?.buffered;
		return ranges && ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
	}

	// ---- titles, shown when the sound reaches them ----
	function emitDueTitles() {
		while (timeline.length > 0 && timeline[0].mediaTime <= audio.currentTime + 0.05) {
			const marker = timeline.shift();
			if (marker) handlers.onTitle?.(marker.title);
		}
	}

	// ---- appending ----
	function trim(force: boolean) {
		if (!sourceBuffer || sourceBuffer.updating) return;
		const start = bufferedStart();
		const end = audio.currentTime - (force ? 5 : options.keepBehindSeconds);
		if (end - start <= 1) return;
		try {
			sourceBuffer.remove(start, end);
			counters.trims++;
		} catch {
			// The next updateend retries.
		}
	}

	function checkLiveEdge() {
		const ahead = bufferedEnd() - audio.currentTime;
		if (!audio.paused && ahead > options.maxAheadSeconds) {
			audio.currentTime = bufferedEnd() - options.liveMarginSeconds;
			counters.liveEdgeJumps++;
		}
	}

	function pump() {
		// The reader may be waiting for room: wake it as soon as the queue has drained enough.
		if (queuedBytes <= options.maxQueueBytes) releaseDrainWaiters();
		if (stopped || !sourceBuffer || sourceBuffer.updating || mediaSource?.readyState !== 'open') {
			return;
		}
		const item = queue.shift();
		if (!item) return;

		if ('marker' in item) {
			// Everything before the metadata block is appended: its media time is the buffered end.
			item.marker.mediaTime = bufferedEnd();
			timeline.push(item.marker);
			if (timeline.length === 1 && !firstTitleSeen) {
				// The very first title describes what is playing right now: show it at once.
				firstTitleSeen = true;
				item.marker.mediaTime = 0;
			}
			emitDueTitles();
			pump();
			return;
		}

		queuedBytes -= item.data.length;
		try {
			sourceBuffer.appendBuffer(item.data as BufferSource);
			counters.appends++;
			counters.bytesAppended += item.data.length;
			quotaRetried = false;
		} catch (error) {
			queuedBytes += item.data.length;
			queue.unshift(item);
			if (error instanceof DOMException && error.name === 'QuotaExceededError') {
				if (quotaRetried) {
					lost('quota');
					return;
				}
				quotaRetried = true;
				trim(true); // make room, the following updateend retries the append
				if (!isUpdating()) lost('quota');
			} else {
				lost('decode', error instanceof Error ? error.message : String(error));
			}
		}
	}

	function onUpdateEnd() {
		if (!sourceBuffer || sourceBuffer.updating) return;
		trim(false);
		if (!isUpdating()) pump();
		checkLiveEdge();
		emitDueTitles();
	}

	function flushBatch() {
		clearTimeout(batchTimer);
		batchTimer = undefined;
		if (batch.length === 0) return;
		const data = new Uint8Array(batchSize);
		let offset = 0;
		for (const part of batch) {
			data.set(part, offset);
			offset += part.length;
		}
		batch = [];
		batchSize = 0;
		queue.push({ data });
		queuedBytes += data.length;
		pump();
	}

	function addAudio(part: Uint8Array) {
		// `part` may be a view into the network chunk: keep a private copy.
		batch.push(new Uint8Array(part));
		batchSize += part.length;
		if (batchSize >= options.batchBytes) flushBatch();
		else batchTimer ??= setTimeout(flushBatch, options.batchMs);
	}

	function addTitle(title: string) {
		flushBatch(); // the marker must sit exactly between the audio before and after the block
		queue.push({ marker: { title, mediaTime: 0 } });
		pump();
	}

	// ---- idle disconnect: a paused live stream only fills memory ----
	function onPause() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			if (stopped || lostReported) return;
			abort.abort();
			handlers.onSuspended?.();
		}, options.idleDisconnectMs);
	}

	function onPlay() {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	}

	function onTimeUpdate() {
		emitDueTitles();
		checkLiveEdge();
	}

	/* eslint-disable no-await-in-loop, @typescript-eslint/no-loop-func -- sequential by design */
	async function waitForRoom() {
		while (queuedBytes > options.maxQueueBytes && !isStopped()) {
			await new Promise<void>((resolve) => {
				drainWaiters.push(resolve);
			});
		}
	}

	async function run() {
		const MediaSourceClass = resolveMediaSource(deps);
		if (!MediaSourceClass?.isTypeSupported(MIME_TYPE)) {
			lost('unsupported');
			return;
		}

		mediaSource = new MediaSourceClass();
		const opened = new Promise<void>((resolve) => {
			mediaSource?.addEventListener(
				'sourceopen',
				() => {
					resolve();
				},
				{ once: true },
			);
		});
		objectUrl = createObjectURL(mediaSource);
		audio.src = objectUrl;
		await opened;
		if (isStopped()) return;

		try {
			sourceBuffer = mediaSource.addSourceBuffer(MIME_TYPE);
		} catch {
			lost('unsupported');
			return;
		}
		sourceBuffer.addEventListener('updateend', onUpdateEnd);
		sourceBuffer.addEventListener('error', () => {
			lost('decode', 'SourceBuffer error');
		});
		audio.addEventListener('timeupdate', onTimeUpdate);
		audio.addEventListener('pause', onPause);
		audio.addEventListener('play', onPlay);
		if (audio.paused) onPause();

		let reader: ReadableStreamDefaultReader<Uint8Array>;
		let push: (chunk: Uint8Array) => void;
		try {
			const response = await fetchImpl(url, {
				headers: { 'Icy-MetaData': '1' },
				signal: abort.signal,
			});
			if (!response.ok) {
				lost('http', String(response.status));
				return;
			}
			if (!response.body) {
				lost('network', 'no response body');
				return;
			}
			const metaint = Number.parseInt(response.headers.get('icy-metaint') ?? '');
			// Without metadata the stream is still playable: everything is audio.
			push = Number.isFinite(metaint)
				? createIcyDemuxer(metaint, { onAudio: addAudio, onTitle: addTitle }).push
				: addAudio;
			reader = response.body.getReader();
		} catch (error) {
			if (!abort.signal.aborted)
				lost('network', error instanceof Error ? error.message : String(error));
			return;
		}

		try {
			for (;;) {
				await waitForRoom();
				if (isStopped()) return;
				const { done, value } = await reader.read();
				if (done) {
					flushBatch();
					lost('ended');
					return;
				}
				push(value);
			}
		} catch (error) {
			if (!abort.signal.aborted)
				lost('network', error instanceof Error ? error.message : String(error));
		}
	}

	/* eslint-enable no-await-in-loop, @typescript-eslint/no-loop-func */

	function stop() {
		if (stopped) return;
		stopped = true;
		abort.abort();
		clearTimeout(batchTimer);
		clearTimeout(idleTimer);
		audio.removeEventListener('timeupdate', onTimeUpdate);
		audio.removeEventListener('pause', onPause);
		audio.removeEventListener('play', onPlay);
		sourceBuffer?.removeEventListener('updateend', onUpdateEnd);
		queue = [];
		batch = [];
		timeline = [];
		queuedBytes = 0;
		releaseDrainWaiters();
		if (objectUrl) revokeObjectURL(objectUrl);
	}

	const done = run()
		.catch((error: unknown) => {
			lost('network', error instanceof Error ? error.message : String(error));
		})
		.then(() => {
			// Reading is over: release the timers, but leave the element playing what is buffered.
			clearTimeout(batchTimer);
		});

	return {
		stop,
		done,
		stats: () => ({ ...counters, queuedBytes }),
	};
}

export { startMseStream };
export type {
	LostReason,
	MseStream,
	MseStreamDeps,
	MseStreamHandlers,
	MseStreamOptions,
	MseStreamStats,
};
