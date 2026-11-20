import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MseStreamHandlers, type MseStreamOptions, startMseStream } from '@/lib/mse-stream';

const BYTES_PER_SECOND = 16000; // the fake decoder turns 16000 bytes into one second of audio
const METAINT = 16000;
const encoder = new TextEncoder();

// ---------------------------------------------------------------- fakes

class FakeSourceBuffer extends EventTarget {
	updating = false;
	ranges: [number, number][] = [];
	appended: Uint8Array[] = [];
	removed: [number, number][] = [];
	nextAppendError: Error | undefined;
	/** Keeps `updating` true until `finishUpdate()` (to test back-pressure deterministically). */
	manual = false;

	get buffered() {
		const ranges = this.ranges;
		return {
			length: ranges.length,
			start: (index: number) => ranges[index][0],
			end: (index: number) => ranges[index][1],
		};
	}

	appendBuffer(data: Uint8Array) {
		if (this.nextAppendError) {
			const error = this.nextAppendError;
			this.nextAppendError = undefined;
			throw error;
		}
		if (this.updating) throw new DOMException('busy', 'InvalidStateError');
		this.updating = true;
		this.appended.push(Uint8Array.from(data));
		const apply = () => {
			const start = this.ranges.length > 0 ? this.ranges[0][0] : 0;
			const end = (this.ranges.length > 0 ? this.ranges[0][1] : 0) + data.length / BYTES_PER_SECOND;
			this.ranges = [[start, end]];
			this.finishUpdate();
		};
		if (this.manual) this.pending = apply;
		else queueMicrotask(apply);
	}

	remove(start: number, end: number) {
		this.updating = true;
		this.removed.push([start, end]);
		queueMicrotask(() => {
			if (this.ranges.length > 0)
				this.ranges = [[Math.max(this.ranges[0][0], end), this.ranges[0][1]]];
			this.finishUpdate();
		});
	}

	pending: (() => void) | undefined;

	release() {
		const apply = this.pending;
		this.pending = undefined;
		apply?.();
	}

	finishUpdate() {
		this.updating = false;
		this.dispatchEvent(new Event('updateend'));
	}

	/** Total audio bytes appended, as one array. */
	get audioBytes() {
		const total = new Uint8Array(this.appended.reduce((sum, part) => sum + part.length, 0));
		let offset = 0;
		for (const part of this.appended) {
			total.set(part, offset);
			offset += part.length;
		}
		return total;
	}
}

class FakeMediaSource extends EventTarget {
	static supported = true;
	static instances: FakeMediaSource[] = [];
	static isTypeSupported() {
		return this.supported;
	}
	readyState: 'closed' | 'open' = 'closed';
	buffer = new FakeSourceBuffer();
	constructor() {
		super();
		FakeMediaSource.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 'open';
			this.dispatchEvent(new Event('sourceopen'));
		});
	}
	addSourceBuffer() {
		return this.buffer;
	}
}

class FakeAudio extends EventTarget {
	src = '';
	paused = false;
	currentTime = 0;
	setTime(seconds: number) {
		this.currentTime = seconds;
		this.dispatchEvent(new Event('timeupdate'));
	}
}

interface FakeServer {
	feed: (bytes: Uint8Array) => void;
	close: () => void;
	fail: (error: Error) => void;
	requests: { url: string; headers: Record<string, string>; cache?: RequestCache }[];
}

function fakeFetch(
	init: { status?: number; metaint?: number | string | null; reject?: Error } = {},
) {
	const notYet = () => {
		throw new Error('the fake connection is not open yet');
	};
	const server: FakeServer = {
		feed: notYet,
		close: notYet,
		fail: notYet,
		requests: [],
	};
	const implementation = vi.fn((url: string, request?: RequestInit) => {
		server.requests.push({
			url,
			headers: (request?.headers ?? {}) as Record<string, string>,
			cache: request?.cache,
		});
		if (init.reject) return Promise.reject(init.reject);
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		request?.signal?.addEventListener('abort', () => {
			try {
				controller.error(new DOMException('aborted', 'AbortError'));
			} catch {
				// already closed
			}
		});
		server.feed = (bytes) => {
			controller.enqueue(bytes);
		};
		server.close = () => {
			controller.close();
		};
		server.fail = (error) => {
			controller.error(error);
		};
		const headers: Record<string, string> = { 'content-type': 'audio/mpeg' };
		if (init.metaint !== null) headers['icy-metaint'] = String(init.metaint ?? METAINT);
		return Promise.resolve(new Response(body, { status: init.status ?? 200, headers }));
	});
	return { fetch: implementation as unknown as typeof fetch, server };
}

/**
 * ICY framing: every element is one `metaint` run of audio (one second) followed by a metadata
 * block: the given title, or `null` for "no change". Run `i` is filled with `fill ?? i + 1`.
 */
function icyStream(blocks: (string | null)[], fill?: number) {
	const chunks: Uint8Array[] = [];
	blocks.forEach((title, index) => {
		chunks.push(new Uint8Array(METAINT).fill(fill ?? index + 1));
		if (title === null) {
			chunks.push(Uint8Array.of(0));
		} else {
			const text = encoder.encode(`StreamTitle='${title}';`);
			const block = new Uint8Array(1 + Math.ceil(text.length / 16) * 16);
			block[0] = Math.ceil(text.length / 16);
			block.set(text, 1);
			chunks.push(block);
		}
	});
	const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		all.set(chunk, offset);
		offset += chunk.length;
	}
	return all;
}

/** Last element (the target lib has no Array#at). */
function last<T>(items: ArrayLike<T>): T | undefined {
	// eslint-disable-next-line unicorn/prefer-at -- the TypeScript lib target has no Array#at
	return items[items.length - 1];
}

const quiet = (seconds: number) => icyStream(Array.from({ length: seconds }, () => null));

// ---------------------------------------------------------------- harness

const urls = { created: [] as string[], revoked: [] as string[] };

function setup(
	fetchInit: Parameters<typeof fakeFetch>[0] = {},
	options: Partial<MseStreamOptions> = {},
	handlerOverrides: Partial<MseStreamHandlers> = {},
) {
	const audio = new FakeAudio();
	const { fetch, server } = fakeFetch(fetchInit);
	const titles: string[] = [];
	const lostReasons: string[] = [];
	const suspended = vi.fn();
	const stream = startMseStream(
		audio as unknown as HTMLAudioElement,
		'https://ice4.somafm.com/deepspaceone-128-mp3',
		{
			onTitle: (title) => titles.push(title),
			onLost: (reason) => lostReasons.push(reason),
			onSuspended: suspended,
			...handlerOverrides,
		},
		options,
		{
			MediaSource: FakeMediaSource as unknown as typeof MediaSource,
			fetch,
			createObjectURL: () => {
				const url = `blob:fake-${String(urls.created.length)}`;
				urls.created.push(url);
				return url;
			},
			revokeObjectURL: (url) => urls.revoked.push(url),
		},
	);
	return {
		audio,
		server,
		stream,
		titles,
		lostReasons,
		suspended,
		buffer: () => {
			const source = FakeMediaSource.instances[0] as FakeMediaSource | undefined;
			if (!source) throw new Error('no MediaSource was created');
			return source.buffer;
		},
	};
}

/** Lets promises and the batch timer run. */
async function settle(ms = 400) {
	await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
	vi.useFakeTimers();
	FakeMediaSource.instances = [];
	FakeMediaSource.supported = true;
	urls.created = [];
	urls.revoked = [];
});

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------- tests

describe('startMseStream setup', () => {
	it('attaches a MediaSource to the element and asks for ICY metadata', async () => {
		const { audio, server } = setup();
		await settle(0);

		expect(audio.src).toBe('blob:fake-0');
		expect(server.requests).toMatchObject([
			{ url: 'https://ice4.somafm.com/deepspaceone-128-mp3', headers: { 'Icy-MetaData': '1' } },
		]);
	});

	it('reports `unsupported` when MP3 is not available in MSE', async () => {
		FakeMediaSource.supported = false;
		const { lostReasons, server } = setup();
		await settle(0);

		expect(lostReasons).toEqual(['unsupported']);
		expect(server.requests).toHaveLength(0); // no connection is wasted
	});

	it('reports `http` for an error status', async () => {
		const { lostReasons } = setup({ status: 403 });
		await settle(0);
		expect(lostReasons).toEqual(['http']);
	});

	it('reports `network` when the connection cannot be made', async () => {
		const { lostReasons } = setup({ reject: new TypeError('Failed to fetch') });
		await settle(0);
		expect(lostReasons).toEqual(['network']);
	});
});

describe('startMseStream audio and titles', () => {
	it('appends the audio without the metadata, in order', async () => {
		const { server, buffer } = setup();
		await settle(0);

		server.feed(icyStream(['A - One', null]));
		await settle();

		const audio = buffer().audioBytes;
		expect(audio).toHaveLength(2 * BYTES_PER_SECOND);
		expect(audio.subarray(0, BYTES_PER_SECOND).every((byte) => byte === 1)).toBe(true);
		expect(audio.subarray(BYTES_PER_SECOND).every((byte) => byte === 2)).toBe(true);
	});

	it('merges small network chunks into larger appends', async () => {
		const { server, buffer } = setup();
		await settle(0);

		const stream = icyStream([null]);
		for (let offset = 0; offset < stream.length; offset += 700)
			server.feed(stream.slice(offset, offset + 700));
		await settle();

		expect(buffer().appended.length).toBeLessThan(5);
		expect(buffer().audioBytes).toHaveLength(BYTES_PER_SECOND);
	});

	it('shows the first title at once, later ones when the sound reaches them', async () => {
		const { audio, server, titles } = setup();
		await settle(0);

		server.feed(icyStream(['First - Song', null, null, null, null, 'Second - Song', null, null]));
		await settle();
		expect(titles).toEqual(['First - Song']); // the second one starts 6 s into the audio

		audio.setTime(5.9);
		expect(titles).toEqual(['First - Song']);
		audio.setTime(6.1);
		expect(titles).toEqual(['First - Song', 'Second - Song']);
	});

	it('plays a stream without ICY metadata as pure audio', async () => {
		const { server, buffer, titles, lostReasons } = setup({ metaint: null });
		await settle(0);

		server.feed(new Uint8Array(BYTES_PER_SECOND).fill(7));
		await settle();

		expect(buffer().audioBytes).toHaveLength(BYTES_PER_SECOND);
		expect(titles).toEqual([]);
		expect(lostReasons).toEqual([]);
	});

	it('reports `ended` once when the server closes the stream, after flushing what it sent', async () => {
		const { server, buffer, lostReasons } = setup();
		await settle(0);

		server.feed(icyStream([null]));
		server.close();
		await settle();

		expect(buffer().audioBytes).toHaveLength(BYTES_PER_SECOND);
		expect(lostReasons).toEqual(['ended']);
	});

	it('reports `network` when the connection breaks mid-stream', async () => {
		const { server, lostReasons } = setup();
		await settle(0);

		server.feed(icyStream([null]));
		await settle();
		server.fail(new TypeError('network error'));
		await settle();

		expect(lostReasons).toEqual(['network']);
	});
});

describe('startMseStream hardening', () => {
	it.each([['0'], ['abc'], ['']])(
		'plays icy-metaint "%s" as pure audio (no metadata)',
		async (value) => {
			const { server, buffer, titles, lostReasons } = setup({
				metaint: value === '' ? null : value,
			});
			await settle(0);

			server.feed(new Uint8Array(BYTES_PER_SECOND).fill(7));
			await settle();

			expect(buffer().audioBytes).toHaveLength(BYTES_PER_SECOND);
			expect(titles).toEqual([]);
			expect(lostReasons).toEqual([]);
		},
	);

	it('refuses an impossible icy-metaint instead of corrupting the audio', async () => {
		const { lostReasons, buffer } = setup({ metaint: 99_999_999 });
		await settle(0);
		expect(lostReasons).toEqual(['decode']);
		expect(buffer().appended).toHaveLength(0);
	});

	it('reports `decode` once when the element lets go of the MediaSource', async () => {
		const { lostReasons, stream } = setup();
		await settle(0);

		FakeMediaSource.instances[0].dispatchEvent(new Event('sourceclose'));
		FakeMediaSource.instances[0].dispatchEvent(new Event('sourceclose'));

		expect(lostReasons).toEqual(['decode']);
		stream.stop();
	});

	it('does not report the MediaSource closing after stop()', async () => {
		const { lostReasons, stream } = setup();
		await settle(0);

		stream.stop();
		FakeMediaSource.instances[0].dispatchEvent(new Event('sourceclose'));

		expect(lostReasons).toEqual([]);
	});

	it('never lets the HTTP cache serve a live stream', async () => {
		const { server } = setup();
		await settle(0);
		expect(server.requests[0].cache).toBe('no-store');
	});
});

describe('startMseStream buffer management', () => {
	it('trims audio that was played more than 15 s ago', async () => {
		const { audio, server, buffer } = setup();
		await settle(0);
		server.feed(quiet(24)); // just below the 25 s live-edge limit
		await settle();

		audio.setTime(10); // only 10 s of history: nothing to trim yet
		server.feed(quiet(1));
		await settle();
		expect(buffer().removed).toEqual([]);

		audio.setTime(20);
		server.feed(quiet(1));
		await settle();
		expect(last(buffer().removed)?.[1]).toBeCloseTo(5, 0); // everything older than 15 s
	});

	it('jumps toward the live edge when it falls too far behind while playing', async () => {
		const { audio, server, stream } = setup();
		await settle(0);

		server.feed(quiet(40)); // far more than 25 s ahead of the playhead
		await settle();

		expect(stream.stats().liveEdgeJumps).toBeGreaterThanOrEqual(1);
		expect(audio.currentTime).toBeGreaterThan(20);
		expect(40 - audio.currentTime).toBeLessThan(25); // back within the allowed distance
	});

	it('does not jump while paused (the owner restarts a stale stream instead)', async () => {
		const { audio, server, stream } = setup();
		await settle(0);
		audio.paused = true;

		server.feed(quiet(40));
		await settle();
		audio.setTime(1);

		expect(audio.currentTime).toBe(1);
		expect(stream.stats().liveEdgeJumps).toBe(0);
	});

	it('stops reading while too much data waits to be appended (back-pressure)', async () => {
		const { server, buffer, stream } = setup({}, { maxQueueBytes: 40000, batchBytes: 16000 });
		await settle(0);
		buffer().manual = true; // the SourceBuffer is busy: appends do not finish

		for (let i = 0; i < 10; i++) server.feed(quiet(1)); // ten network chunks
		await settle();
		const queuedWhileBlocked = stream.stats().queuedBytes;
		expect(queuedWhileBlocked).toBeLessThanOrEqual(40000 + METAINT * 2);
		expect(queuedWhileBlocked).toBeGreaterThan(0);

		buffer().manual = false;
		for (let i = 0; i < 12; i++) {
			buffer().release();
			// eslint-disable-next-line no-await-in-loop -- each step must settle before the next release
			await settle(10);
		}
		expect(stream.stats().bytesAppended).toBe(10 * METAINT);
	});

	it('retries an append after trimming when the quota is exceeded', async () => {
		const { audio, server, buffer, lostReasons } = setup();
		await settle(0);
		server.feed(quiet(24));
		await settle();
		audio.setTime(20);
		await settle();

		buffer().nextAppendError = new DOMException('full', 'QuotaExceededError');
		server.feed(icyStream([null], 9));
		await settle();

		expect(last(buffer().removed)?.[1]).toBeCloseTo(15, 0); // forced trim keeps only 5 s behind
		expect(last(buffer().audioBytes)).toBe(9); // the data still got in
		expect(lostReasons).toEqual([]);
	});

	it('reports `quota` when trimming cannot make room', async () => {
		const { server, buffer, lostReasons } = setup();
		await settle(0);

		buffer().nextAppendError = new DOMException('full', 'QuotaExceededError');
		server.feed(icyStream([null]));
		await settle();

		expect(lostReasons).toEqual(['quota']);
	});

	it('reports `decode` when the SourceBuffer rejects the data', async () => {
		const { server, buffer, lostReasons } = setup();
		await settle(0);

		buffer().nextAppendError = new DOMException('bad data', 'InvalidStateError');
		server.feed(icyStream([null]));
		await settle();

		expect(lostReasons).toEqual(['decode']);
	});
});

describe('startMseStream idle disconnect and stop', () => {
	it('drops the connection when the element stays paused', async () => {
		const { audio, server, suspended, lostReasons } = setup();
		await settle(0);
		server.feed(icyStream([null]));
		await settle();

		audio.paused = true;
		audio.dispatchEvent(new Event('pause'));
		await settle(19000);
		expect(suspended).not.toHaveBeenCalled();
		await settle(1500);

		expect(suspended).toHaveBeenCalledOnce();
		expect(lostReasons).toEqual([]); // a suspend is not an error
	});

	it('keeps the connection when playback resumes in time', async () => {
		const { audio, server, suspended } = setup();
		await settle(0);
		server.feed(icyStream([null]));
		await settle();

		audio.paused = true;
		audio.dispatchEvent(new Event('pause'));
		await settle(10000);
		audio.paused = false;
		audio.dispatchEvent(new Event('play'));
		await settle(60000);

		expect(suspended).not.toHaveBeenCalled();
	});

	it('stop() releases everything and silences all callbacks', async () => {
		const { audio, server, stream, titles, lostReasons, buffer } = setup();
		await settle(0);
		server.feed(icyStream([null, null, 'Late - Title', null]));

		stream.stop();
		stream.stop(); // twice is fine
		await settle();
		audio.setTime(100);

		expect(urls.revoked).toEqual(['blob:fake-0']);
		expect(titles).toEqual([]);
		expect(lostReasons).toEqual([]);
		expect(buffer().appended).toHaveLength(0);
		await expect(stream.done).resolves.toBeUndefined();
	});

	it('stop() while connecting does not report an error', async () => {
		const { stream, lostReasons } = setup();
		stream.stop();
		await settle();
		expect(lostReasons).toEqual([]);
	});
});
