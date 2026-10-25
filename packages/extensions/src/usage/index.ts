import { defineExtension } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { usageMigrations } from "./migrations.ts";
import { createUsageService, type UsageService } from "./service.ts";

export type UsageModule = DomainModule & {
	/** The sampler, the dashboard's numbers and the budget gate the daily jobs ask. One per `deps`. */
	service: (deps: DomainDeps) => UsageService;
};

const services = new WeakMap<DomainDeps, UsageService>();

function serviceFor(deps: DomainDeps): UsageService {
	let service = services.get(deps);
	if (service === undefined) {
		service = createUsageService(deps);
		services.set(deps, service);
	}
	return service;
}

export const usageModule: UsageModule = {
	name: "usage",
	migrations: usageMigrations,
	service: serviceFor,
	// No tools and no prompt section: the module is its tables and its service, which the server and the daily jobs use.
	extension: () => defineExtension({ name: "usage" }),
};

export {
	type AgentIdentity,
	ALERT_SAMPLE_MAX_AGE_MS,
	createUsageService,
	type UsageService,
	weekStartOf,
} from "./service.ts";
export * as usageStore from "./store.ts";
