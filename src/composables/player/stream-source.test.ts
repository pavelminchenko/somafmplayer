import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createStreamSource } from '@/composables/player/stream-source';
import type { StreamTransport } from '@/lib/stream-transport';

const MIRRORS = [
	'https://ice4.somafm.com/a',
	'https://ice6.somafm.com/a',
	'https://ice2.somafm.com/a',
];

function fakeElement() {
	return { src: '', autoplay: true, preload: 'auto', load: vi.fn() };
}

function setup(transport: 'element' | 'mse' = 'element') {
	const element = fakeElement();
	const sources = ref([...MIRRORS]);
	const mseTransports: StreamTransport[] = [];
	const source = createStreamSource({
		getElement: () => element as unknown as HTMLAudioElement,
		sources,
		transport,
		createMseTransport: () => {
			const fake: StreamTransport = {
				kind: 'mse',
				open: vi.fn(),
				reopen: vi.fn(),
				start: vi.fn(),
				close: vi.fn(),
			};
			mseTransports.push(fake);
			return fake;
		},
		callbacks: { onTitle: vi.fn(), onLost: vi.fn(), onSuspended: vi.fn() },
	});
	return { element, sources, source, mseTransports };
}

describe('createStreamSource (element transport)', () => {
	it('opens the primary server of a channel', () => {
		const { element, source } = setup();
		expect(source.hasSource()).toBe(false);

		source.openChannel(MIRRORS, true);

		expect(element.src).toBe(MIRRORS[0]);
		expect(source.hasSource()).toBe(true);
	});

	it('reloads on the next mirror, round-robin', () => {
		const { element, source } = setup();
		source.openChannel(MIRRORS, true);

		source.reload({ nextMirror: true });
		expect(element.src).toBe(MIRRORS[1]);
		source.reload({ nextMirror: true });
		expect(element.src).toBe(MIRRORS[2]);
		source.reload({ nextMirror: true });
		expect(element.src).toBe(MIRRORS[0]); // wraps around
	});

	it('reloads the same mirror with load() when asked not to rotate', () => {
		const { element, source } = setup();
		source.openChannel(MIRRORS, true);

		source.reload({ nextMirror: false });

		expect(element.load).toHaveBeenCalledOnce();
		expect(element.src).toBe(MIRRORS[0]);
	});

	it('starts again from the primary server', () => {
		const { element, source } = setup();
		source.openChannel(MIRRORS, true);
		source.reload({ nextMirror: true });
		source.reload({ nextMirror: true });

		source.restartFromPrimary();

		expect(element.src).toBe(MIRRORS[0]);
	});

	it('only prepares a channel when told not to start (restored after a reload)', () => {
		const { element, source } = setup();
		source.openChannel(MIRRORS, false);
		expect(element).toMatchObject({ src: MIRRORS[0], autoplay: false, preload: 'none' });
	});

	it('uses load() when there are no sources to rotate', () => {
		const element = fakeElement();
		const source = createStreamSource({
			getElement: () => element as unknown as HTMLAudioElement,
			transport: 'element',
			callbacks: { onTitle: vi.fn(), onLost: vi.fn(), onSuspended: vi.fn() },
		});
		source.reload({ nextMirror: true });
		expect(element.load).toHaveBeenCalledOnce();
	});
});

describe('createStreamSource (MSE transport and fallback)', () => {
	it('is "MSE without sound" until it has played, then an ordinary stream', () => {
		const { source } = setup('mse');
		source.openChannel(MIRRORS, true);
		expect(source.isMseWithoutSound()).toBe(true);

		source.markPlayed();

		expect(source.isMseWithoutSound()).toBe(false);
	});

	it('markPlayed does nothing for the element transport', () => {
		const { source } = setup('element');
		source.openChannel(MIRRORS, true);
		source.markPlayed();
		expect(source.isMseWithoutSound()).toBe(false);
	});

	it('falls back to the element for this channel and reports whether there is a URL', () => {
		const { element, source, mseTransports } = setup('mse');
		expect(source.fallbackToElement()).toBe(false); // nothing was opened yet
		source.openChannel(MIRRORS, true);

		expect(source.fallbackToElement()).toBe(true);
		source.openCurrent(true);

		expect(mseTransports[0].close).toHaveBeenCalled();
		expect(element.src).toBe(MIRRORS[0]);
		expect(source.isMseWithoutSound()).toBe(false);
	});

	it('the next channel tries MSE again after a channel-level fallback', () => {
		const { source, mseTransports } = setup('mse');
		source.openChannel(MIRRORS, true);
		source.fallbackToElement('network');

		source.openChannel(['https://ice2.somafm.com/b'], true);

		expect(mseTransports).toHaveLength(2);
	});

	it('stays on the element for good when MSE is unsupported', () => {
		const { element, source, mseTransports } = setup('mse');
		source.openChannel(MIRRORS, true);
		source.fallbackToElement('unsupported');

		source.openChannel(['https://ice2.somafm.com/b'], true);

		expect(mseTransports).toHaveLength(1);
		expect(element.src).toBe('https://ice2.somafm.com/b');
	});

	it('start() and close() reach the current transport', () => {
		const { source, mseTransports } = setup('mse');
		source.openChannel(MIRRORS, false);

		source.start();
		source.close();

		expect(mseTransports[0].start).toHaveBeenCalledOnce();
		expect(mseTransports[0].close).toHaveBeenCalledOnce();
	});
});
