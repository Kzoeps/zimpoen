// Bundles the server and the workspace packages it imports (`@assistant/*`, shipped as TypeScript source) into one
// ESM file. Third-party dependencies stay external and are loaded from node_modules at runtime.
import { rm } from "node:fs/promises";
import { build } from "esbuild";
import pkg from "../package.json" with { type: "json" };

const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@assistant/"));

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
// main.js is the server; broker.js is the separate zimpoen-broker process (ops/systemd/zimpoen-broker.service).
await build({
	entryPoints: {
		main: new URL("../src/main.ts", import.meta.url).pathname,
		broker: new URL("../src/broker-main.ts", import.meta.url).pathname,
	},
	outdir: new URL("../dist", import.meta.url).pathname,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	sourcemap: true,
	external,
	logLevel: "info",
});
