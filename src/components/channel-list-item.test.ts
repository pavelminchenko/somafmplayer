// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ChannelListItem from '@/components/ChannelListItem.vue';
import { useMainStore } from '@/stores/main-store';
import { mountComponent } from '@/test/mount';
import type { ChannelSummary } from '@/types';

const channel = {
	id: 'groovesalad',
	title: 'Groove Salad',
	genre: 'ambient',
	image: 'https://somafm.com/img/groovesalad.jpg',
	playlists: [],
} as unknown as ChannelSummary;

let mounted: ReturnType<typeof mountComponent> | undefined;

afterEach(() => {
	mounted?.unmount();
	mounted = undefined;
});

describe('ChannelListItem', () => {
	it('renders the channel as a list item with a descriptive button', () => {
		mounted = mountComponent(ChannelListItem, { data: channel });

		const item = mounted.el.querySelector('li.channel-list-item');
		expect(item).not.toBeNull();
		expect(item?.querySelector('.title')?.textContent).toBe('Groove Salad');
		expect(item?.querySelector('.genre')?.textContent).toBe('ambient');
		expect(mounted.el.querySelector('button')?.textContent.trim()).toBe('Play Groove Salad');
	});

	it('does not put the API-provided id into the DOM', () => {
		mounted = mountComponent(ChannelListItem, { data: channel });
		expect(mounted.el.querySelector('#groovesalad')).toBeNull();
	});

	it('treats the channel image as decorative', () => {
		mounted = mountComponent(ChannelListItem, { data: channel });
		expect(mounted.el.querySelector('img')?.getAttribute('alt')).toBe('');
	});

	it('requests the channel from the store on click', () => {
		mounted = mountComponent(ChannelListItem, { data: channel });
		const store = useMainStore();
		const spy = vi.spyOn(store, 'setCurrentChannel').mockResolvedValue();

		mounted.el.querySelector('button')?.click();

		expect(spy).toHaveBeenCalledWith(channel);
	});

	it('marks the playing channel with aria-current and the current class', async () => {
		mounted = mountComponent(ChannelListItem, { data: channel });
		const button = mounted.el.querySelector('button');
		expect(button?.hasAttribute('aria-current')).toBe(false);

		useMainStore().currentChannel = { ...channel, songs: [] };
		await nextTick();

		expect(button?.getAttribute('aria-current')).toBe('true');
		expect(mounted.el.querySelector('li')?.classList.contains('current')).toBe(true);
	});
});
