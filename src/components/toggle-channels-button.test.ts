// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ToggleChannelsButton from '@/components/ToggleChannelsButton.vue';
import { useMainStore } from '@/stores/main-store';
import { mountComponent } from '@/test/mount';

let mounted: ReturnType<typeof mountComponent> | undefined;

afterEach(() => {
	mounted?.unmount();
	mounted = undefined;
});

describe('ToggleChannelsButton', () => {
	it('toggles the drawer and keeps aria-expanded and the icon in sync', async () => {
		mounted = mountComponent(ToggleChannelsButton);
		const button = mounted.el.querySelector('button');
		expect(button?.getAttribute('aria-expanded')).toBe('false');
		expect(button?.classList.contains('icon-menu')).toBe(true);

		button?.click();
		await nextTick();

		expect(useMainStore().mobileChannelsOpen).toBe(true);
		expect(button?.getAttribute('aria-expanded')).toBe('true');
		expect(button?.classList.contains('icon-close')).toBe(true);

		button?.click();
		await nextTick();
		expect(useMainStore().mobileChannelsOpen).toBe(false);
	});
});
