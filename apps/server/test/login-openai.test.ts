import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthEvent, AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { deviceIdIn, runLoginOpenAI, runLogoutOpenAI } from "../src/login/openai.ts";

/*
 * The real sign-in opens a browser and talks to auth.openai.com. None of that may happen in a test, so the provider is a
 * stand-in whose `oauth.login` plays the flow through the same callbacks (`notify`, `prompt`) the real one uses.
 */

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ACCESS = "access-token-that-must-never-be-printed";
const REFRESH = "refresh-token-that-must-never-be-printed";

async function fixture() {
	const data = await mkdtemp(join(tmpdir(), "assistant-login-"));
	dirs.push(data);
	const lines: string[] = [];
	return { data, env: { ASSISTANT_DATA_DIR: data }, lines, print: (line: string) => void lines.push(line) };
}

type FakeFlow = (
	interaction: AuthInteraction,
	options: { getDeviceId?: () => string } | undefined,
) => Promise<OAuthCredential>;

/** A provider with the id `openai` whose sign-in is `flow`, over the faux model's machinery. */
function fakeOpenAI(flow: FakeFlow): Provider {
	const base = fauxProvider({ provider: "openai", models: [{ id: "fake-1", name: "Fake" }] }).provider;
	return {
		...base,
		auth: {
			oauth: {
				name: "OpenAI (fake ChatGPT)",
				login: (interaction, options) => flow(interaction, options),
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
	};
}

const credential = (): OAuthCredential => ({
	type: "oauth",
	access: ACCESS,
	refresh: REFRESH,
	expires: Date.now() + 3_600_000,
	clientId: "client-1",
});

/** What a normal sign-in does: show the link, wait for the browser (here: the person pastes the address), return the tokens. */
const normalFlow: FakeFlow = async (interaction) => {
	const event: AuthEvent = {
		type: "auth_url",
		url: "https://auth.example/authorize?state=abc",
		instructions: "Complete sign-in in your browser.",
	};
	interaction.notify(event);
	await interaction.prompt({
		type: "manual_code",
		message: "Complete login in your browser, or paste the final redirect URL here:",
	});
	interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
	return credential();
};

const modeOf = async (path: string) => ((await stat(path)).mode & 0o777).toString(8);

describe("pnpm login:openai", () => {
	it("prints the link and what to do, saves the sign-in privately, and never prints a token", async () => {
		const f = await fixture();
		const asked: string[] = [];

		const code = await runLoginOpenAI({
			argv: [],
			env: f.env,
			print: f.print,
			ask: async (question) => {
				asked.push(question);
				return "http://127.0.0.1:1455/auth/callback?code=x";
			},
			provider: fakeOpenAI(normalFlow),
		});

		const out = f.lines.join("\n");
		expect(code).toBe(0);
		expect(out).toContain("https://auth.example/authorize?state=abc");
		expect(out).toContain("Open this link in a browser on THIS computer");
		expect(out).toContain("http://127.0.0.1:1455/auth/callback"); // what to paste when the browser is on another machine
		expect(out).toContain(`saved in ${join(f.data, "secrets", "credentials.json")}`);
		expect(out).toContain("no restart is needed");
		expect(out).not.toContain(ACCESS);
		expect(out).not.toContain(REFRESH);
		expect(asked[0]).toContain("paste the final redirect URL");

		const stored = JSON.parse(await readFile(join(f.data, "secrets", "credentials.json"), "utf8"));
		expect(stored.openai).toMatchObject({ type: "oauth", access: ACCESS, refresh: REFRESH, clientId: "client-1" });
		expect(await modeOf(join(f.data, "secrets", "credentials.json"))).toBe("600");
		expect(await modeOf(join(f.data, "secrets"))).toBe("700");
	});

	it("gives OpenAI the same installation id every time, kept next to the credentials", async () => {
		const f = await fixture();
		const seen: string[] = [];
		const flow: FakeFlow = async (_interaction, options) => {
			seen.push(options?.getDeviceId?.() ?? "none");
			return credential();
		};
		const run = () =>
			runLoginOpenAI({ argv: [], env: f.env, print: f.print, ask: async () => "", provider: fakeOpenAI(flow) });

		await run();
		await run();

		expect(seen[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(seen[1]).toBe(seen[0]);
		expect(await deviceIdIn(join(f.data, "secrets"))).toBe(seen[0]);
		expect(await modeOf(join(f.data, "secrets", "device-id"))).toBe("600");
	});

	it("closes a secrets folder and a credential file that were left open, and keeps the other providers' sign-ins", async () => {
		const f = await fixture();
		await mkdir(join(f.data, "secrets"), { recursive: true });
		await chmod(join(f.data, "secrets"), 0o755);
		await writeFile(
			join(f.data, "secrets", "credentials.json"),
			JSON.stringify({ other: { type: "api_key", key: "k" } }),
		);
		await chmod(join(f.data, "secrets", "credentials.json"), 0o644);

		const code = await runLoginOpenAI({
			argv: [],
			env: f.env,
			print: f.print,
			ask: async () => "",
			provider: fakeOpenAI(normalFlow),
		});

		expect(code).toBe(0);
		expect(await modeOf(join(f.data, "secrets"))).toBe("700");
		expect(await modeOf(join(f.data, "secrets", "credentials.json"))).toBe("600");
		const stored = JSON.parse(await readFile(join(f.data, "secrets", "credentials.json"), "utf8"));
		expect(Object.keys(stored).sort()).toStrictEqual(["openai", "other"]);
	});

	it("says what went wrong and saves nothing when the sign-in fails or is cancelled", async () => {
		const f = await fixture();
		await mkdir(join(f.data, "secrets"), { recursive: true });
		await writeFile(join(f.data, "secrets", "credentials.json"), JSON.stringify({ openai: credential() }));
		const failing: FakeFlow = async () => {
			throw new Error("Port 1455 is in use, probably by an unfinished login in another pi session.");
		};

		const code = await runLoginOpenAI({
			argv: [],
			env: f.env,
			print: f.print,
			ask: async () => "",
			provider: fakeOpenAI(failing),
		});

		expect(code).toBe(1);
		expect(f.lines.join("\n")).toContain("Could not sign in: Port 1455 is in use");
		// What was saved before is untouched.
		expect(JSON.parse(await readFile(join(f.data, "secrets", "credentials.json"), "utf8")).openai.refresh).toBe(
			REFRESH,
		);
	});

	it("prints its usage for --help without touching the data directory, and refuses a flag it does not know", async () => {
		const f = await fixture();
		const help = await runLoginOpenAI({ argv: ["--help"], env: f.env, print: f.print });
		expect(help).toBe(0);
		expect(f.lines.join("\n")).toContain("pnpm login:openai");
		await expect(stat(join(f.data, "secrets"))).rejects.toThrow();

		const bad = await runLoginOpenAI({ argv: ["--token", "x"], env: f.env, print: f.print });
		expect(bad).toBe(2);
	});

	it("needs a terminal to ask in, and says so", async () => {
		const f = await fixture();
		const code = await runLoginOpenAI({ argv: [], env: f.env, print: f.print, provider: fakeOpenAI(normalFlow) });
		expect(code).toBe(1);
		expect(f.lines.join("\n")).toContain("needs a terminal");
	});
});

describe("pnpm logout:openai", () => {
	it("removes the OpenAI sign-in and keeps the others", async () => {
		const f = await fixture();
		await mkdir(join(f.data, "secrets"), { recursive: true });
		await writeFile(
			join(f.data, "secrets", "credentials.json"),
			JSON.stringify({ openai: credential(), other: { type: "api_key", key: "k" } }),
		);

		const code = await runLogoutOpenAI({ argv: [], env: f.env, print: f.print, provider: fakeOpenAI(normalFlow) });

		expect(code).toBe(0);
		const stored = JSON.parse(await readFile(join(f.data, "secrets", "credentials.json"), "utf8"));
		expect(Object.keys(stored)).toStrictEqual(["other"]);
		expect(f.lines.join("\n")).toContain("Removed the OpenAI sign-in");
		expect(f.lines.join("\n")).not.toContain(REFRESH);
	});

	it("says there is nothing to remove when nothing is saved, and is not an error", async () => {
		const f = await fixture();
		const code = await runLogoutOpenAI({ argv: [], env: f.env, print: f.print, provider: fakeOpenAI(normalFlow) });
		expect(code).toBe(0);
		expect(f.lines.join("\n")).toContain("nothing to remove");
	});
});
