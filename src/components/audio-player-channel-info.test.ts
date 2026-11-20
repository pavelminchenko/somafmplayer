// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import AudioPlayerChannelInfo from '@/components/AudioPlayerChannelInfo.vue';
import { useMainStore } from '@/stores/main-store';
import { mountComponent } from '@/test/mount';
import type { Channel } from '@/types';

const channel = {
	id: 'deepspaceone',
	title: 'Deep Space One',
	genre: 'ambient',
	description: 'Deep ambient electronic.',
	songs: [{ title: 'Api Song', artist: 'Api Artist' }],
} as unknown as Channel;

let mounted: ReturnType<typeof mountComponent> | undefined;

afterEach(() => {
	mounted?.unmount();
	mounted = undefined;
});

function mountInfo() {
	mounted = mountComponent(AudioPlayerChannelInfo, {}, () => {
		useMainStore().currentChannel = channel;
	});
	const text = () => mounted?.el.querySelector('.current-song')?.textContent;
	return { store: useMainStore(), text };
}

describe('AudioPlayerChannelInfo', () => {
	it('shows the API song until the stream delivers a title', async () => {
		const { text } = mountInfo();
		await nextTick();
		expect(text()).toBe('Api Artist - Api Song');
	});

	it('switches to the title from the stream, and back when it disappears', async () => {
		const { store, text } = mountInfo();

		store.liveTitle = 'Live Artist - Live Song';
		await nextTick();
		expect(text()).toBe('Live Artist - Live Song');

		store.liveTitle = 'Another - One';
		await nextTick();
		expect(text()).toBe('Another - One');

		store.liveTitle = '';
		await nextTick();
		expect(text()).toBe('Api Artist - Api Song');
	});

	it('shows a stream title without an artist as is', async () => {
		const { store, text } = mountInfo();
		store.liveTitle = 'Station jingle';
		await nextTick();
		expect(text()).toBe('Station jingle');
	});

	it('renders the title as text, never as HTML', async () => {
		const { store } = mountInfo();
		store.liveTitle = '<img src=x onerror=alert(1)> - <b>bold</b>';
		await nextTick();

		expect(mounted?.el.querySelector('.current-song img')).toBeNull();
		expect(mounted?.el.querySelector('.current-song b')).toBeNull();
		expect(mounted?.el.querySelector('.current-song')?.textContent).toContain('<img');
	});
});
