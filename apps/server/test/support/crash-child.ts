/**
 * A real assistant server in its own process, for tests that must kill it without any chance to clean up.
 * Configured through the environment (`ASSISTANT_DATA_DIR` and friends); prints `READY <port>` once it is serving and
 * then waits to be killed. The scripted model streams at `CRASH_CHILD_TOKENS_PER_SECOND` (default 20).
 */
import { loadConfig } from "../../src/config.ts";
import { startServer } from "../../src/server.ts";

const config = await loadConfig(process.env);
const server = await startServer(
	{ ...config, http: { ...config.http, port: 0 } },
	{ devModel: { tokensPerSecond: Number(process.env.CRASH_CHILD_TOKENS_PER_SECOND ?? 20) } },
);
console.log(`READY ${server.port}`);
setInterval(() => {}, 1 << 30);
