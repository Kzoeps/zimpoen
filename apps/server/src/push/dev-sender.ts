import { appendFile } from "node:fs/promises";
import type { PushSender } from "./sender.ts";

type Logger = Pick<Console, "info">;

/**
 * The sender for development and tests: nothing leaves the machine. It appends what it would have sent to a JSON Lines
 * file, one object per delivery, and logs a line, so a developer can see a reminder reach "the phone" without one.
 */
export function createFakePushSender(outboxPath: string, logger: Logger = console): PushSender {
	return {
		async send(target, payload) {
			const record = { at: new Date().toISOString(), endpoint: target.endpoint, payload };
			await appendFile(outboxPath, `${JSON.stringify(record)}\n`);
			logger.info(`[push:fake] would send ${JSON.stringify(payload)} to ${new URL(target.endpoint).host}`);
		},
	};
}
