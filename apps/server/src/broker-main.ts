// zimpoen-broker: runs policy actions with credentials the server never sees, over a unix socket (plan §9).
// Started by ops/systemd/zimpoen-broker.service; in development, ZIMPOEN_CRED_BROKER=inprocess needs no broker at all.
import { parseBrokerEnv, startBrokerService } from "./broker-service.ts";

try {
	const server = await startBrokerService(parseBrokerEnv(process.env));
	const stop = (): void => {
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 10_000).unref();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
