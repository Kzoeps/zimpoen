import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	// The web app's tsconfig says `jsx: preserve` because Next compiles JSX itself; a test that renders a component to markup
	// (apps/web/test/health-cards.test.ts) needs Vite to turn it into calls.
	oxc: { jsx: { runtime: "automatic" } },
	test: {
		environment: "node",
		include: ["{apps,packages}/*/test/**/*.test.ts", "{apps,packages}/*/src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/.next/**"],
		// Integration tests open real SQLite files and run Durable tasks; give slow CI-like laptops room.
		testTimeout: 20_000,
		hookTimeout: 20_000,
	},
});
