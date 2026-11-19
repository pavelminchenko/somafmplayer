import { describe, expect, it, vi } from 'vitest';
import { Analyser, type AnalyserHost } from '@/lib/audio-visualizer';

const FRAMES = 60;
const BINS = 1024;

/** Deterministic pseudo-random spectra in dB; frame 3 is silent (Number.NEGATIVE_INFINITY) like a real analyser. */
function makeFrames() {
	let seed = 42;
	const random = () => (seed = (seed * 0x19_66_0d + 0x3c_6e_f3_5f) >>> 0) / 2 ** 32;
	return Array.from({ length: FRAMES }, (_, frame) => {
		const spectrum = new Float32Array(BINS);
		for (let i = 0; i < BINS; i++)
			spectrum[i] = frame === 3 ? Number.NEGATIVE_INFINITY : -100 + random() * 90;
		return spectrum;
	});
}

/** Runs one analyser for FRAMES updates and returns every canvas `lineTo` coordinate. */
function drawPath(offset: number, isReady = true) {
	const frames = makeFrames();
	let current = 0;
	const coordinates: number[] = [];

	const canvasContext = {
		beginPath: vi.fn(),
		fill: vi.fn(),
		lineTo: (x: number, y: number) => {
			coordinates.push(x, y);
		},
		strokeStyle: '',
		fillStyle: '',
	};
	const analyserNode = {
		fftSize: 0,
		smoothingTimeConstant: 0,
		getFloatFrequencyData: (target: Float32Array) => {
			target.set(frames[current]);
		},
	};
	const host = {
		isReady,
		audioContext: { sampleRate: 44100, createAnalyser: () => analyserNode },
		visual: { canvasContext, tick: 0 },
	} as unknown as AnalyserHost;

	const analyser = new Analyser({
		audio: host,
		color: '#fff',
		smoothTime: 0.7,
		scale: 2,
		min: 1,
		max: 600,
		offset,
		radius: 350,
	});
	for (current = 0; current < FRAMES; current++) {
		host.visual.tick += 0.07;
		analyser.update();
	}
	return { analyserNode, coordinates, canvasContext };
}

/** SHA-256 over the raw float64 bytes, so even a 1-ulp difference is detected. */
async function hash(coordinates: number[]) {
	const bytes = new Float64Array(coordinates);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('Analyser geometry', () => {
	// Hashes were taken from the original JavaScript implementation, so this guards the exact
	// picture (every path point) against accidental changes while refactoring or optimizing.
	it('draws the same path as the reference for a delayed analyser (offset 1)', async () => {
		const { coordinates } = drawPath(1);
		expect(coordinates).toHaveLength(57600);
		expect(await hash(coordinates)).toBe(
			'46586baf04155cde508b0b5d4259390904021b7d99d131e01f299dcbde4aa3eb',
		);
	});

	it('draws the same path as the reference for a live analyser (offset -1)', async () => {
		const { coordinates } = drawPath(-1);
		expect(coordinates).toHaveLength(57600);
		expect(await hash(coordinates)).toBe(
			'f53da6544c4b097d7c8b98781b02aaabeedad8a2e69741016699808a05133930',
		);
	});

	it('configures the analyser node', () => {
		const { analyserNode } = drawPath(1);
		expect(analyserNode.fftSize).toBe(2048);
		expect(analyserNode.smoothingTimeConstant).toBe(0.7);
	});

	it('only reads the analyser while the sound graph is ready', () => {
		const { coordinates, analyserNode } = drawPath(1, false);
		let reads = 0;
		analyserNode.getFloatFrequencyData = () => reads++;
		expect(reads).toBe(0);
		// A silent ring is still drawn (a base circle), it just never reacts.
		expect(coordinates.length).toBeGreaterThan(0);
	});
});
