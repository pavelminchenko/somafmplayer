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
					@import '@/assets/styles/global/_variables.scss';
					@import '@/assets/styles/global/_media-queries.scss';
					@import '@/assets/styles/global/_functions.scss';
					@import '@/assets/styles/global/_mixins.scss';
				`,
			},
		},
	},
});
