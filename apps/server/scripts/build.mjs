// Bundles the server and the workspace packages it imports (`@assistant/*`, shipped as TypeScript source) into one
// ESM file. Third-party dependencies stay external and are loaded from node_modules at runtime.
import { rm } from "node:fs/promises";
import { build } from "esbuild";
import pkg from "../package.json" with { type: "json" };

const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@assistant/"));

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await build({
	entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
	outfile: new URL("../dist/main.js", import.meta.url).pathname,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	sourcemap: true,
	external,
	logLevel: "info",
});
