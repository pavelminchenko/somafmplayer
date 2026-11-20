import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MseStreamHandlers } from '@/lib/mse-stream';
import {
	createElementTransport,
	createMseTransport,
	readTransportPreference,
	type TransportCallbacks,
} from '@/lib/stream-transport';

function fakeElement() {
	return { src: '', autoplay: true, preload: 'auto', load: vi.fn() };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('element transport', () => {
	it('points the element at the URL, with autoplay/preload set before src', () => {
		const element = fakeElement();
		const transport = createElementTransport(() => element as unknown as HTMLAudioElement);

		transport.open('https://ice4.somafm.com/a', true);

		expect(element).toMatchObject({
			src: 'https://ice4.somafm.com/a',
			autoplay: true,
			preload: 'auto',
		});
	});

	it('only prepares the stream when asked not to start (restored channel)', () => {
		const element = fakeElement();
		const transport = createElementTransport(() => element as unknown as HTMLAudioElement);

		transport.open('https://ice4.somafm.com/a', false);

		expect(element).toMatchObject({ autoplay: false, preload: 'none' });
	});

	it('reconnects with load() and has nothing to start or release', () => {
		const element = fakeElement();
		const transport = createElementTransport(() => element as unknown as HTMLAudioElement);

		transport.reopen();
		transport.start();
		transport.close();

		expect(element.load).toHaveBeenCalledOnce();
		expect(transport.kind).toBe('element');
	});

	it('tolerates a missing element', () => {
		const transport = createElementTransport(() => null);
		expect(() => {
			transport.open('https://x', true);
			transport.reopen();
		}).not.toThrow();
	});
});

function setupMse() {
	const element = fakeElement();
	const streams: { url: string; handlers: MseStreamHandlers; stop: ReturnType<typeof vi.fn> }[] =
		[];
	const callbacks: TransportCallbacks = {
		onTitle: vi.fn(),
		onLost: vi.fn(),
		onSuspended: vi.fn(),
	};
	const start = vi.fn((_element: HTMLAudioElement, url: string, handlers?: MseStreamHandlers) => {
		const stop = vi.fn();
		streams.push({ url, handlers: handlers ?? {}, stop });
		return { stop, done: Promise.resolve(), stats: vi.fn() };
	});
	const transport = createMseTransport(() => element as unknown as HTMLAudioElement, callbacks, {
		start: start,
	});
	return { element, streams, callbacks, start, transport };
}

describe('mse transport', () => {
	it('starts a stream for the URL and forwards its events', () => {
		const { streams, callbacks, transport } = setupMse();

		transport.open('https://ice4.somafm.com/a', true);
		streams[0].handlers.onTitle?.('Artist - Song');
		streams[0].handlers.onLost?.('network');
		streams[0].handlers.onSuspended?.();

		expect(streams[0].url).toBe('https://ice4.somafm.com/a');
		expect(callbacks.onTitle).toHaveBeenCalledWith('Artist - Song');
		expect(callbacks.onLost).toHaveBeenCalledWith('network');
		expect(callbacks.onSuspended).toHaveBeenCalledOnce();
		expect(transport.kind).toBe('mse');
	});

	it('does not connect until start() when the stream is only prepared', () => {
		const { element, start, transport } = setupMse();

		transport.open('https://ice4.somafm.com/a', false);
		expect(start).not.toHaveBeenCalled();
		expect(element.autoplay).toBe(false);

		transport.start();
		transport.start(); // a second start does not open a second connection
		expect(start).toHaveBeenCalledOnce();
	});

	it('replaces the stream when a new URL is opened', () => {
		const { streams, transport } = setupMse();

		transport.open('https://ice4.somafm.com/a', true);
		transport.open('https://ice6.somafm.com/a', true);

		expect(streams[0].stop).toHaveBeenCalledOnce();
		expect(streams).toHaveLength(2);
		expect(streams[1].url).toBe('https://ice6.somafm.com/a');
	});

	it('reopen() starts a fresh connection to the same URL', () => {
		const { streams, transport } = setupMse();
		transport.open('https://ice4.somafm.com/a', true);

		transport.reopen();

		expect(streams[0].stop).toHaveBeenCalledOnce();
		expect(streams[1].url).toBe('https://ice4.somafm.com/a');
	});

	it('close() stops the stream and is safe to repeat', () => {
		const { streams, transport } = setupMse();
		transport.open('https://ice4.somafm.com/a', true);

		transport.close();
		transport.close();

		expect(streams[0].stop).toHaveBeenCalledOnce();
	});
});

function stubBrowser(search: string, stored: Record<string, string> = {}) {
	const store = new Map(Object.entries(stored));
	vi.stubGlobal('location', { search });
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
	});
	return store;
}

describe('readTransportPreference', () => {
	it('defaults to the element transport', () => {
		stubBrowser('');
		expect(readTransportPreference()).toBe('element');
	});

	it('?transport=mse switches to MSE and remembers it', () => {
		const store = stubBrowser('?transport=mse');
		expect(readTransportPreference()).toBe('mse');
		expect(store.get('somafm-player:transport')).toBe('mse');

		vi.stubGlobal('location', { search: '' });
		expect(readTransportPreference()).toBe('mse'); // remembered
	});

	it('?transport=audio switches back', () => {
		stubBrowser('?transport=audio', { 'somafm-player:transport': 'mse' });
		expect(readTransportPreference()).toBe('element');
	});

	it('ignores unknown values and a broken environment', () => {
		stubBrowser('?transport=banana');
		expect(readTransportPreference()).toBe('element');
		vi.unstubAllGlobals();
		expect(readTransportPreference()).toBe('element'); // no location / storage in Node
	});
});
