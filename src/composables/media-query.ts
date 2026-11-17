import { onMounted, onUnmounted, ref } from 'vue';

export function useMediaQuery(query: string) {
	const mediaQueryList = matchMedia(query);
	// Start from the real value to avoid a layout flash before `onMounted`.
	const matches = ref(mediaQueryList.matches);
	const handler = (event: MediaQueryList | MediaQueryListEvent) => {
		matches.value = event.matches;
	};

	onMounted(() => {
		mediaQueryList.addEventListener('change', handler);
		handler(mediaQueryList);
	});

	onUnmounted(() => {
		mediaQueryList.removeEventListener('change', handler);
	});

	return matches;
}
