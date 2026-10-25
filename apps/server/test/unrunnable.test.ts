import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { listUnrunnableTasks } from "../src/agents.ts";
import { openRuntime } from "../src/runtime.ts";
import { createFixture, removeAllFixtures } from "./support.ts";

const ctx = BACKGROUND_CONTEXT;
afterEach(removeAllFixtures);

/** A timer like the assistant's: it sleeps for a long time, and is "waiting" until its extension is gone. */
const timer = defineTask<{ id: string }, { phase: "wait" }, { done: true }>({
	name: "test.timer",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (_task, runtime, context) => {
			await runtime.sleepUntil(Date.now() + 365 * 24 * 60 * 60_000, { phase: "wait" }, context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
const extension = defineExtension({ name: "test-timers", tasks: [timer] });

describe("listUnrunnableTasks", () => {
	it("finds a sleeping timer whose definition is no longer installed, and says nothing while it is", async () => {
		const fixture = await createFixture();
		const first = await openRuntime(fixture.config, { extensions: [extension] });
		const conversation = await first.harness.root(ctx, {});
		await conversation.commit(
			(tx) => tx.createTask(timer, { id: "p_1" }, { ownership: { kind: "conversation" }, background: true }),
			ctx,
		);
		expect(await listUnrunnableTasks(first.harness)).toStrictEqual([]);
		await first.close();

		// A later version of the code without that task (or with its version changed and no migration).
		const second = await openRuntime(fixture.config);
		try {
			expect(await listUnrunnableTasks(second.harness)).toMatchObject([{ kind: "test.timer", reason: "missing_task" }]);
		} finally {
			await second.close();
		}
	});
});
