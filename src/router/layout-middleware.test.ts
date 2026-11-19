import { describe, expect, it } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';
import { loadLayout } from '@/router/layout-middleware';

const makeRoute = (meta: RouteLocationNormalized['meta']) => ({ meta }) as RouteLocationNormalized;

describe('loadLayout', () => {
	it('loads the Default layout when the route does not name one', async () => {
		const route = makeRoute({});
		await loadLayout(route);
		expect(route.meta.layoutComponent).toBeDefined();
	});

	it('loads a layout by name', async () => {
		const route = makeRoute({ layout: 'Default' });
		await loadLayout(route);
		expect(route.meta.layoutComponent).toBeDefined();
	});

	it('fails with a clear message for an unknown layout', async () => {
		await expect(loadLayout(makeRoute({ layout: 'Nope' }))).rejects.toThrow(
			"The layout named 'Nope' does not exist",
		);
	});
});
