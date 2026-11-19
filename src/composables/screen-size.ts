import { useMediaQuery } from '@vueuse/core';
import { reactive, type Ref } from 'vue';
import mediaQueries from '@/assets/styles/export/_media-queries.module.scss';

/**
 * Reactive map of the project's media queries (`max-width-sm`, `only-width-md`, ...).
 * Read the values as plain booleans: `reactive` unwraps the refs, so there is no `.value`.
 */
export function useScreenSize(): Record<string, boolean> {
	const queries: Record<string, Ref<boolean>> = {};
	for (const [key, query] of Object.entries(mediaQueries)) {
		queries[key] = useMediaQuery(query);
	}
	// Vue's types do not unwrap refs behind an index signature, hence the explicit cast.
	return reactive(queries) as unknown as Record<string, boolean>;
}
