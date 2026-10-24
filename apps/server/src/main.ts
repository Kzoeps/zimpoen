import { ConfigError, loadConfig } from "./config.ts";
import { type RunningServer, startServer } from "./server.ts";

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
	const config = await loadConfig();
	if (config.auth.mode === "off") {
		console.warn("[auth] Authentication is OFF (ASSISTANT_AUTH=off). Use this for local development only.");
	}
	const server = await startServer(config);
	installShutdown(server);
}

/** SIGINT and SIGTERM close the Harness cleanly, so the next start resumes exactly where this one stopped. */
function installShutdown(server: RunningServer): void {
	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.info(`[shutdown] ${signal} received, closing...`);
		const force = setTimeout(() => {
			console.error(`[shutdown] still running after ${SHUTDOWN_TIMEOUT_MS / 1000}s, exiting anyway.`);
			process.exit(1);
		}, SHUTDOWN_TIMEOUT_MS);
		force.unref();
		server.close().then(
			() => process.exit(0),
			(error) => {
				console.error("[shutdown] failed:", error);
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
	if (error instanceof ConfigError) console.error(error.message);
	else console.error(error);
	process.exit(1);
});
