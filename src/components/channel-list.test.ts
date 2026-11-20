// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ChannelList from '@/components/ChannelList.vue';
import { useMainStore } from '@/stores/main-store';
import { mountComponent } from '@/test/mount';
import type { ChannelSummary } from '@/types';

const channels = ['a', 'b', 'c'].map(
	(id) =>
		({
			id,
			title: `Channel ${id}`,
			genre: 'g',
			image: '',
			playlists: [],
		}) as unknown as ChannelSummary,
);

let mounted: ReturnType<typeof mountComponent> | undefined;

afterEach(() => {
	mounted?.unmount();
	mounted = undefined;
});

describe('ChannelList', () => {
	it('renders one list item per channel inside a ul', () => {
		mounted = mountComponent(ChannelList, { data: channels });

		const items = mounted.el.querySelectorAll('ul.channels > li.channel-list-item');
		expect([...items].map((item) => item.querySelector('.title')?.textContent)).toEqual([
			'Channel a',
			'Channel b',
			'Channel c',
		]);
	});

	it('renders an empty list without errors', () => {
		mounted = mountComponent(ChannelList, { data: [] });
		expect(mounted.el.querySelectorAll('li')).toHaveLength(0);
	});

	it('opens as a drawer on mobile when the store flag is set', async () => {
		mounted = mountComponent(ChannelList, { data: channels });
		const root = mounted.el.querySelector('.channel-list');
		expect(root?.classList.contains('channels-open')).toBe(false);

		useMainStore().mobileChannelsOpen = true;
		await nextTick();

		expect(root?.classList.contains('channels-open')).toBe(true);
	});
});
