import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { normalizeVolume, useLevelControl } from '@/composables/player/level-control';

function setup() {
	vi.useFakeTimers();
	const audio = { volume: 1, pause: vi.fn() };
	const element = ref(audio as unknown as HTMLAudioElement);
	const scope = effectScope();
	const level = scope.run(() => useLevelControl(element));
	if (!level) throw new Error('useLevelControl did not run');
	return { audio, level, scope };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('normalizeVolume', () => {
	it.each([
		[0, 0],
		[0.4, 0.4],
		[1, 1],
		[7, 1],
		[-0.1, 1],
		[Number.NaN, 1],
	])('normalizes %f to %f', (input, expected) => {
		expect(normalizeVolume(input)).toBe(expected);
	});
});

describe('useLevelControl without Web Audio (element volume)', () => {
	it('applies the volume to the element', async () => {
		const { audio, level } = setup();
		await nextTick();
		expect(audio.volume).toBe(1);

		level.setVolume(0.3);
		await nextTick();

		expect(level.volume.value).toBe(0.3);
		expect(audio.volume).toBe(0.3);
	});

	it('multiplies the volume by the envelope', async () => {
		const { audio, level } = setup();
		level.setVolume(0.5);
		await nextTick();

		level.setEnvelope(0);
		expect(audio.volume).toBe(0);
		level.setEnvelope(1);
		expect(audio.volume).toBe(0.5);
	});

	it('pauses at once when there is nothing to fade with', () => {
		const { audio, level } = setup();
		level.pauseSoftly(audio as unknown as HTMLAudioElement);
		expect(audio.pause).toHaveBeenCalledOnce();
	});

	it('duck() resolves immediately without a Web Audio graph', async () => {
		const { level } = setup();
		await expect(level.duck()).resolves.toBeUndefined();
	});

	it('cancelPendingPause and dispose are safe to call', () => {
		const { level, scope } = setup();
		expect(() => {
			level.cancelPendingPause();
			level.dispose();
			scope.stop();
		}).not.toThrow();
	});
});
