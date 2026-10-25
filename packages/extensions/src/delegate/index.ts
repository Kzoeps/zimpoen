import { defineExtension } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { delegateMigrations } from "./migrations.ts";
import { createDelegateService, createDelegateTools, type DelegateService } from "./tools.ts";

export const DELEGATE_EXTENSION_NAME = "delegate";

export type DelegateModule = DomainModule & {
	/** What happens to an answer that nobody waited for. */
	service: (deps: DomainDeps) => DelegateService;
};

const services = new WeakMap<DomainDeps, DelegateService>();

function serviceFor(deps: DomainDeps): DelegateService {
	let service = services.get(deps);
	if (service === undefined) {
		service = createDelegateService(deps);
		services.set(deps, service);
	}
	return service;
}

export const delegateModule: DelegateModule = {
	name: "delegate",
	migrations: delegateMigrations,
	service: serviceFor,
	extension: (deps) =>
		defineExtension({ name: DELEGATE_EXTENSION_NAME, tools: createDelegateTools(deps, serviceFor(deps)) }),
};

export * as delegateStore from "./store.ts";
export type { DelegateService } from "./tools.ts";
export { ASK_HEAD, answerTextOf, framedQuestion, MAX_ANSWER_CHARS } from "./tools.ts";
