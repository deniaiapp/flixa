import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts', 'webview-ui/src/**/*.test.{ts,tsx}'],
		setupFiles: ['./webview-ui/src/test/setup.ts'],
	},
});
