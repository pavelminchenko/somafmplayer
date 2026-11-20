// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import AudioPlayerElementControls from '@/components/AudioPlayerElementControls.vue';
import { useMainStore } from '@/stores/main-store';
import { mountComponent } from '@/test/mount';

let mounted: ReturnType<typeof mountComponent> | undefined;

function mountControls(props: { isPlaying?: boolean; volume?: number } = {}) {
	const onPlayback = vi.fn();
	const onVolume = vi.fn();
	mounted = mountComponent(AudioPlayerElementControls, {
		isPlaying: false,
		volume: 1,
		...props,
		'onUpdate:playback': onPlayback,
		'onUpdate:volume': onVolume,
	});
	const query = (selector: string) => {
		const element = mounted?.el.querySelector<HTMLElement>(selector);
		if (!element) throw new Error(`No element for ${selector}`);
		return element;
	};
	return { onPlayback, onVolume, query };
}

function setSlider(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input'));
}

afterEach(() => {
	mounted?.unmount();
	mounted = undefined;
});

describe('AudioPlayerElementControls playback button', () => {
	it('shows Play while paused and Pause while playing', () => {
		const paused = mountControls({ isPlaying: false });
		expect(paused.query('.playback-button').textContent.trim()).toBe('Play');
		expect(paused.query('.playback-button').classList.contains('icon-play')).toBe(true);
		mounted?.unmount();

		const playing = mountControls({ isPlaying: true });
		expect(playing.query('.playback-button').textContent.trim()).toBe('Pause');
		expect(playing.query('.playback-button').classList.contains('icon-pause')).toBe(true);
	});

	it('emits update:playback with the current state when clicked', () => {
		const { onPlayback, query } = mountControls({ isPlaying: true });
		query('.playback-button').click();
		expect(onPlayback).toHaveBeenCalledWith(true);
	});
});

describe('AudioPlayerElementControls channel buttons', () => {
	it('moves to the previous and next channel through the store', () => {
		const { query } = mountControls();
		const spy = vi.spyOn(useMainStore(), 'selectAdjacentChannel').mockResolvedValue();

		query('.prev-button').click();
		query('.next-button').click();

		expect(spy.mock.calls).toEqual([[-1], [1]]);
	});
});

describe('AudioPlayerElementControls volume', () => {
	it('has an accessible volume slider reflecting the volume', () => {
		const { query } = mountControls({ volume: 0.4 });
		const slider = query('.volumebar input') as HTMLInputElement;
		expect(slider.getAttribute('aria-label')).toBe('Volume');
		expect(slider.value).toBe('0.4');
	});

	it('emits the slider value', () => {
		const { onVolume, query } = mountControls({ volume: 1 });
		setSlider(query('.volumebar input') as HTMLInputElement, '0.25');
		expect(onVolume).toHaveBeenCalledWith(0.25);
	});

	it('mutes and restores the previous volume', async () => {
		const { onVolume, query } = mountControls({ volume: 0.6 });
		const mute = query('.mute-button');
		expect(mute.textContent.trim()).toBe('Mute');

		mute.click();
		expect(onVolume).toHaveBeenLastCalledWith(0);

		// The parent applies the emitted volume.
		mounted?.unmount();
		const muted = mountControls({ volume: 0 });
		expect(muted.query('.mute-button').textContent.trim()).toBe('Unmute');
		expect(muted.query('.mute-button').classList.contains('icon-mute')).toBe(true);
		await nextTick();
	});

	it('unmutes to full volume when nothing was remembered (e.g. stored volume 0)', () => {
		const { onVolume, query } = mountControls({ volume: 0 });
		query('.mute-button').click();
		expect(onVolume).toHaveBeenLastCalledWith(1);
	});

	it('remembers the last non-zero slider value for unmuting', () => {
		const { onVolume, query } = mountControls({ volume: 0 });
		setSlider(query('.volumebar input') as HTMLInputElement, '0.7');
		onVolume.mockClear();

		query('.mute-button').click(); // props.volume is still 0 -> unmute
		expect(onVolume).toHaveBeenLastCalledWith(0.7);
	});
});
