import { createPinia, setActivePinia } from 'pinia';
import { type Component, type ComponentPublicInstance, createApp } from 'vue';

interface Mounted {
	/** The container element holding the rendered component. */
	el: HTMLElement;
	vm: ComponentPublicInstance;
	unmount: () => void;
}

/**
 * Minimal component mounter for tests (a `@vue/test-utils` replacement without its
 * `js-beautify` dependency tree). Event listeners are passed as `onXxx` props.
 */
// `component` is typed `unknown` because ESLint cannot resolve the types of `.vue` imports.
export function mountComponent(component: unknown, props: Record<string, unknown> = {}): Mounted {
	const pinia = createPinia();
	setActivePinia(pinia);

	const el = document.createElement('div');
	document.body.append(el);

	const app = createApp(component as Component, props);
	app.use(pinia);
	const vm = app.mount(el);

	return {
		el,
		vm,
		unmount() {
			app.unmount();
			el.remove();
		},
	};
}
