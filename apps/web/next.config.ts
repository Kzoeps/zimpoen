import { MAX_UPLOAD_BYTES } from "@assistant/shared";
import type { NextConfig } from "next";

const repoRoot = new URL("../../", import.meta.url).pathname;

const config: NextConfig = {
	reactStrictMode: true,
	poweredByHeader: false,
	// `next dev` otherwise writes an AGENTS.md of generic Next.js advice into this directory.
	agentRules: false,
	// The floating dev badge sits on top of the composer on phones.
	devIndicators: false,
	// The shared packages are TypeScript source, compiled together with the app.
	transpilePackages: ["@assistant/shared"],
	// There are lockfiles above this repository too; name the real root so Next does not guess.
	outputFileTracingRoot: repoRoot,
	turbopack: { root: repoRoot },
	experimental: {
		// Next buffers a proxied request body and, past 10 MB by default, stops forwarding it: an upload through the `/api/*`
		// rewrite below would hang and fail. The limit is the server's own upload cap plus room for the multipart framing,
		// so that the server, which answers 413 with a reason, is what refuses a file that is too big.
		proxyClientMaxBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
	},
	async rewrites() {
		// One origin for the browser: pages from Next, `/api/*` from the assistant server. Tailscale Serve does the same
		// split in production, so this proxy only exists for development and for running without Tailscale.
		const api = process.env.ASSISTANT_API_ORIGIN ?? "http://127.0.0.1:3001";
		return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
	},
};

export default config;
