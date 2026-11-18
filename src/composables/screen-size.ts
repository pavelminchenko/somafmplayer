import { useMediaQuery } from '@vueuse/core';
import { reactive, type Ref } from 'vue';
import mediaQueries from '@/assets/styles/export/_media-queries.module.scss';

export function useScreenSize() {
	return reactive(
		Object.entries(mediaQueries).reduce(
			(initialValue: Record<string, Ref<boolean>>, [key, value]) => {
				initialValue[key] = useMediaQuery(value);
				return initialValue;
			},
			{},
		),
	);
}
