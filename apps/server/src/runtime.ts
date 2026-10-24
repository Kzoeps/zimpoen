import { createProfileExtension } from "@assistant/extensions";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, type Extension, Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Config } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { createDevProvider, type DevProviderOptions } from "./dev-model.ts";
import { scopedEnvFor } from "./env/scoped-env.ts";
import { createUnansweredReader, type UnansweredReader } from "./unanswered.ts";

export type Runtime = {
	harness: Harness;
	models: MutableModels;
	credentials: FileCredentialStore;
	/** Extensions every agent gets. */
	shared: readonly Extension[];
	/** Messages of a conversation that got no answer, with Durable's reason: read from the stored submission records. */
	unanswered: UnansweredReader;
	/** Stop work, wait for running tasks to return and release `durable.sqlite`. */
	close(): Promise<void>;
};

export type RuntimeOptions = {
	/** Durable's failure channel: faulted tasks, throwing hooks, and the error that fails the session. */
	onReport?: HarnessOptions["onReport"];
	/** Pacing of the scripted model in `faux` mode. Ignored in `openai` mode. */
	devModel?: DevProviderOptions;
	/**
	 * How many crashes in a row a task survives before Durable parks it (default 5). A graceful close never counts.
	 * Lower it only to test what a parked task looks like.
	 */
	restartLimit?: number;
	/** Domain extensions (tasks, approvals, ...) to install next to the profile. Agents select the ones they use by name. */
	extensions?: readonly Extension[];
	/** The Harness clock, epoch ms (default `Date.now`). Sleeping tasks keep their deadlines on it; tests pass a fake. */
	now?: () => number;
	/** Timers of the Harness (default `setTimeout`). Tests pass fakes. */
	setTimer?: HarnessOptions["setTimer"];
};

/**
 * Build everything Durable needs from the configuration: models for the configured mode, the extension registry,
 * the scoped file environment, and the Harness on `durable.sqlite`.
 *
 * Opening recovers state but starts no work: call `harness.resume()` once the agents exist.
 * Makes no network request and never logs in; the OpenAI provider only reads credentials when a request is made.
 */
export async function openRuntime(config: Config, options: RuntimeOptions = {}): Promise<Runtime> {
	const credentials = new FileCredentialStore(config.paths.credentials);
	const models = createModels({ credentials });
	models.setProvider(config.modelMode === "faux" ? createDevProvider(options.devModel).provider : openaiProvider());

	const profile = createProfileExtension(config.profile);
	const registry = createRegistry();
	registry.install(profile);
	for (const extension of options.extensions ?? []) registry.install(extension);

	const storage = await openNodeSqliteStorage(config.paths.durableDb);
	let harness: Harness;
	try {
		harness = await Harness.open(
			storage,
			{
				models,
				registry,
				env: scopedEnvFor(config),
				onReport: options.onReport,
				...(options.now === undefined ? {} : { now: options.now }),
				...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
				...(options.restartLimit === undefined ? {} : { settings: { restartLimit: options.restartLimit } }),
			},
			BACKGROUND_CONTEXT,
		);
	} catch (error) {
		await storage.close(BACKGROUND_CONTEXT).catch(() => {});
		throw error;
	}

	return {
		harness,
		models,
		credentials,
		shared: [profile],
		unanswered: createUnansweredReader(storage),
		close: () => harness.close(BACKGROUND_CONTEXT),
	};
}
