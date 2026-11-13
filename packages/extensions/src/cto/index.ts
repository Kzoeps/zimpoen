import { defineExtension } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { ctoMigrations } from "./migrations.ts";
import { createCtoTools } from "./tools.ts";

export const CTO_EXTENSION_NAME = "cto";

/**
 * The CTO's board tools (PLAN upgrade §7): `delegate_coding` and `board_status`. With `deps.cto` absent
 * (`ZIMPOEN_CTO=off`, the default) it registers no tool; its table is still migrated so the flag can flip freely.
 */
export const ctoModule: DomainModule = {
	name: "cto",
	migrations: ctoMigrations,
	extension: (deps: DomainDeps) =>
		defineExtension({
			name: CTO_EXTENSION_NAME,
			tools: deps.cto === undefined ? [] : createCtoTools({ ...deps, cto: deps.cto }),
		}),
};

export {
	CARD_ID_PATTERN,
	type CardRequest,
	type CodingCard,
	type CodingLead,
	createFakeCodingLead,
	type FakeCodingLead,
	leadMessage,
	parseCardShow,
} from "./lead.ts";
export * as ctoStore from "./store.ts";
export { CTO_LIMITS, CTO_SCHEDULED_REFUSAL, type CtoDeps, validateCodingArgs } from "./tools.ts";
