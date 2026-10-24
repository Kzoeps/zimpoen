import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["{apps,packages}/*/test/**/*.test.ts", "{apps,packages}/*/src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/.next/**"],
		// Integration tests open real SQLite files and run Durable tasks; give slow CI-like laptops room.
		testTimeout: 20_000,
		hookTimeout: 20_000,
	},
});
