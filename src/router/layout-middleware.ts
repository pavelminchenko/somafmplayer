import { type Component, markRaw } from 'vue';
import type { RouteLocationNormalized } from 'vue-router';

declare module 'vue-router' {
	interface RouteMeta {
		/** File name (without extension) in `src/layouts`; `Default` when omitted. */
		layout?: string;
		/** Resolved by `loadLayout` before the route is entered; rendered by `App.vue`. */
		layoutComponent?: Component;
	}
}

// Layouts are loaded lazily. A static glob lets Vite analyze and bundle them, which a
// template-string `import()` of an arbitrary name cannot do reliably.
const layouts = import.meta.glob<{ default: Component }>('../layouts/*.vue');

export async function loadLayout(route: RouteLocationNormalized) {
	const layoutName = route.meta.layout ?? 'Default';
	const load = layouts[`../layouts/${layoutName}.vue`] as
		(() => Promise<{ default: Component }>) | undefined;
	if (!load) throw new Error(`The layout named '${layoutName}' does not exist`);

	// markRaw: route.meta is reactive and components must not be turned into reactive proxies.
	const layout = await load();
	route.meta.layoutComponent = markRaw(layout.default);
}
