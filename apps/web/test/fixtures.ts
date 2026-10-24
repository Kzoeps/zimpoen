import type { StreamBatch } from "@assistant/shared";
import chatTurns from "./fixtures/chat-turns.json" with { type: "json" };
import noModel from "./fixtures/no-model.json" with { type: "json" };
import restartResume from "./fixtures/restart-resume.json" with { type: "json" };
import stopMidway from "./fixtures/stop-midway.json" with { type: "json" };

/** Event streams recorded from the real server by `apps/server/scripts/record-fixtures.ts`. */
export type Recording = { description: string; connections: StreamBatch[][] };

export const recordings = {
	chatTurns: chatTurns as unknown as Recording,
	stopMidway: stopMidway as unknown as Recording,
	restartResume: restartResume as unknown as Recording,
	noModel: noModel as unknown as Recording,
};
