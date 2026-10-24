import { describe, expect, it } from "vitest";
import { createProfileExtension, PROFILE_EXTENSION_NAME, renderProfile } from "../src/index.ts";

const facts = { ownerName: "Dorje", timezone: "Asia/Thimphu", currency: "BTN" };

describe("profile extension", () => {
	it("tells the agent who the owner is and which time zone and currency to assume", () => {
		const text = renderProfile(facts);

		expect(text).toContain("Owner: Dorje");
		expect(text).toContain("Time zone: Asia/Thimphu");
		expect(text).toContain("Currency: BTN");
	});

	it("renders identical text on every call, so it never invalidates the provider's prompt cache", () => {
		const extension = createProfileExtension(facts);
		const [profile] = extension.sections ?? [];

		expect(extension.name).toBe(PROFILE_EXTENSION_NAME);
		expect(extension.tools ?? []).toHaveLength(0);
		expect(profile?.key).toBe("profile");
		const render = (): unknown => profile?.render({} as never, {} as never);
		expect(render()).toBe(render());
		expect(render()).toBe(renderProfile(facts));
	});
});
