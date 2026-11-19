import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import autoprefixer from 'autoprefixer';
import { defineConfig } from 'vitest/config';
// import postcssPxtorem from 'postcss-pxtorem';

export default defineConfig({
	base: '/',

	server: {
		port: 3000,
		strictPort: true,
	},

	plugins: [vue()],

	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
	},

	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},

	css: {
		postcss: {
			plugins: [
				autoprefixer(),
				// postcssPxtorem({
				// 	rootValue: 16,
				// 	unitPrecision: 5,
				// 	propList: ['*'],
				// 	selectorBlackList: [],
				// 	replace: true,
				// 	mediaQuery: false,
				// 	minPixelValue: 2,
				// 	exclude: /node_modules/i,
				// }),
			],
		},
		preprocessorOptions: {
			scss: {
				additionalData: `
					@use '@/assets/styles/global/variables' as *;
					@use '@/assets/styles/global/media-queries' as *;
					@use '@/assets/styles/global/functions' as *;
					@use '@/assets/styles/global/mixins' as *;
				`,
			},
		},
	},
});
