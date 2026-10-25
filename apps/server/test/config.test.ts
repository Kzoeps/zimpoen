import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, type Env, loadConfig, parseConfig } from "../src/config.ts";

const context = { cwd: "/work/assistant", homeDir: "/home/dorje" };
const auth = { ASSISTANT_AUTH: "off" };

function problemsOf(env: Env): string[] {
	try {
		parseConfig(env, context);
	} catch (error) {
		if (error instanceof ConfigError) return error.problems.map((problem) => problem.setting);
		throw error;
	}
	return [];
}

describe("parseConfig", () => {
	it("derives every path from the data directory, resolving a relative one against the working directory", () => {
		const config = parseConfig({ ...auth, ASSISTANT_DATA_DIR: "./state" }, context);

		expect(config.dataDir).toBe("/work/assistant/state");
		expect(config.paths).toStrictEqual({
			appDb: "/work/assistant/state/app.sqlite",
			durableDb: "/work/assistant/state/durable.sqlite",
			files: "/work/assistant/state/files",
			workspace: "/work/assistant/state/workspace",
			secrets: "/work/assistant/state/secrets",
			credentials: "/work/assistant/state/secrets/credentials.json",
			vapid: "/work/assistant/state/secrets/vapid.json",
			pushOutbox: "/work/assistant/state/dev-push-outbox.jsonl",
		});
		expect(config.writePath).toBe("/work/assistant/state/workspace");
	});

	it("keeps development and production data apart: ./data-dev unless NODE_ENV=production, then ./data", () => {
		expect(parseConfig({ ...auth }, context).dataDir).toBe("/work/assistant/data-dev");
		const production = {
			ASSISTANT_OWNER_LOGIN: "a@b.c",
			ASSISTANT_PUSH_SUBJECT: "mailto:a@b.c",
			NODE_ENV: "production",
		};
		expect(parseConfig(production, context).dataDir).toBe("/work/assistant/data");
		expect(parseConfig({ ...production, ASSISTANT_DATA_DIR: "/srv/a" }, context).dataDir).toBe("/srv/a");
	});

	it("refuses ASSISTANT_AUTH=off in production, and says how to try the production build locally", () => {
		let caught: unknown;
		try {
			parseConfig({ NODE_ENV: "production", ASSISTANT_AUTH: "off", ASSISTANT_PUSH_SUBJECT: "mailto:a@b.c" }, context);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ConfigError);
		expect((caught as ConfigError).problems.map((problem) => problem.setting)).toStrictEqual(["ASSISTANT_AUTH"]);
		expect((caught as ConfigError).message).toMatch(
			/refused when NODE_ENV=production.*ASSISTANT_OWNER_LOGIN.*without NODE_ENV/s,
		);
		expect(parseConfig({ ASSISTANT_AUTH: "off" }, context).auth).toStrictEqual({ mode: "off" });
	});

	it("defaults to reading Documents and Downloads plus the uploads folder, bound to loopback port 3001", () => {
		const config = parseConfig({ ...auth }, context);

		expect(config.readPaths).toStrictEqual([
			"/home/dorje/Documents",
			"/home/dorje/Downloads",
			"/work/assistant/data-dev/files",
		]);
		expect(config.http).toStrictEqual({ host: "127.0.0.1", port: 3001, publicHosts: [] });
		expect(config.profile).toStrictEqual({ ownerName: "the owner", timezone: "Asia/Thimphu", currency: "BTN" });
		expect(config.health).toStrictEqual({});
	});

	it("reads every setting from the environment", () => {
		const config = parseConfig(
			{
				ASSISTANT_DATA_DIR: "/srv/assistant",
				ASSISTANT_READ_PATHS: "/srv/in:/srv/other",
				ASSISTANT_AUTH: "on",
				ASSISTANT_OWNER_LOGIN: "dorje@example.com",
				ASSISTANT_OWNER_NAME: "Dorje",
				ASSISTANT_TIMEZONE: "Europe/London",
				ASSISTANT_CURRENCY: "USD",
				ASSISTANT_OWNER_HEIGHT_CM: "176.5",
				ASSISTANT_MODEL_MODE: "openai",
				ASSISTANT_PORT: "4100",
				ASSISTANT_PUBLIC_HOST: "My-Laptop.tail1234.ts.net, other.example",
			},
			context,
		);

		expect(config.dataDir).toBe("/srv/assistant");
		expect(config.readPaths).toStrictEqual(["/srv/in", "/srv/other", "/srv/assistant/files"]);
		expect(config.auth).toStrictEqual({ mode: "on", ownerLogin: "dorje@example.com" });
		// The height is for the Health module only: it must not ride in the profile every agent is given.
		expect(config.profile).toStrictEqual({ ownerName: "Dorje", timezone: "Europe/London", currency: "USD" });
		expect(config.health).toStrictEqual({ heightCm: 176.5 });
		expect(config.modelMode).toBe("openai");
		expect(config.http.port).toBe(4100);
		expect(config.http.publicHosts).toStrictEqual(["my-laptop.tail1234.ts.net", "other.example"]);
	});

	it("uses the faux model outside production and the OpenAI model in production", () => {
		const owner = { ASSISTANT_OWNER_LOGIN: "a@b.c", ASSISTANT_PUSH_SUBJECT: "mailto:a@b.c" };
		expect(parseConfig({ ...auth }, context).modelMode).toBe("faux");
		expect(parseConfig({ ...owner, NODE_ENV: "production" }, context).modelMode).toBe("openai");
		expect(parseConfig({ ...owner, NODE_ENV: "production", ASSISTANT_MODEL_MODE: "faux" }, context).modelMode).toBe(
			"faux",
		);
	});

	it("sends no real push outside production, real ones in production, unless told otherwise", () => {
		const owner = { ASSISTANT_OWNER_LOGIN: "a@b.c" };

		expect(parseConfig({ ...auth }, context).push).toStrictEqual({
			mode: "fake",
			subject: "mailto:assistant@localhost",
		});
		const contact = { ASSISTANT_PUSH_SUBJECT: "mailto:me@example.com" };
		expect(parseConfig({ ...owner, ...contact, NODE_ENV: "production" }, context).push.mode).toBe("web-push");
		expect(parseConfig({ ...owner, NODE_ENV: "production", ASSISTANT_PUSH_MODE: "fake" }, context).push.mode).toBe(
			"fake",
		);
		expect(
			parseConfig(
				{ ...auth, ASSISTANT_PUSH_MODE: "web-push", ASSISTANT_PUSH_SUBJECT: "https://me.example/contact" },
				context,
			).push,
		).toStrictEqual({ mode: "web-push", subject: "https://me.example/contact" });
	});

	it("asks for a real contact address before it sends real pushes, and accepts the placeholder while nothing is sent", () => {
		const owner = { ASSISTANT_OWNER_LOGIN: "a@b.c" };

		expect(problemsOf({ ...owner, NODE_ENV: "production" })).toStrictEqual(["ASSISTANT_PUSH_SUBJECT"]);
		expect(problemsOf({ ...owner, ASSISTANT_PUSH_MODE: "web-push" })).toStrictEqual(["ASSISTANT_PUSH_SUBJECT"]);
		expect(problemsOf({ ...owner, NODE_ENV: "production", ASSISTANT_PUSH_MODE: "fake" })).toStrictEqual([]);
		expect(problemsOf({ ...owner })).toStrictEqual([]);
	});

	it("requires an owner login while authentication is on, which is the default", () => {
		expect(problemsOf({})).toStrictEqual(["ASSISTANT_OWNER_LOGIN"]);
		expect(parseConfig({ ASSISTANT_OWNER_LOGIN: "a@b.c" }, context).auth).toStrictEqual({
			mode: "on",
			ownerLogin: "a@b.c",
		});
	});

	it.each([
		["ASSISTANT_AUTH", { ASSISTANT_AUTH: "maybe" }],
		["ASSISTANT_MODEL_MODE", { ...auth, ASSISTANT_MODEL_MODE: "gpt" }],
		["ASSISTANT_PUSH_MODE", { ...auth, ASSISTANT_PUSH_MODE: "fcm" }],
		["ASSISTANT_PUSH_SUBJECT", { ...auth, ASSISTANT_PUSH_SUBJECT: "assistant@example.com" }],
		["ASSISTANT_PUSH_SUBJECT", { ...auth, ASSISTANT_PUSH_SUBJECT: "http://example.com" }],
		["ASSISTANT_PORT", { ...auth, ASSISTANT_PORT: "70000" }],
		["ASSISTANT_PORT", { ...auth, ASSISTANT_PORT: "3001.5" }],
		["ASSISTANT_PORT", { ...auth, ASSISTANT_PORT: "0x10" }],
		["ASSISTANT_PORT", { ...auth, ASSISTANT_PORT: "1e3" }],
		["ASSISTANT_PUBLIC_HOST", { ...auth, ASSISTANT_PUBLIC_HOST: "https://laptop.ts.net" }],
		["ASSISTANT_PUBLIC_HOST", { ...auth, ASSISTANT_PUBLIC_HOST: "laptop.ts.net/api" }],
		["ASSISTANT_TIMEZONE", { ...auth, ASSISTANT_TIMEZONE: "Mars/Olympus" }],
		["ASSISTANT_CURRENCY", { ...auth, ASSISTANT_CURRENCY: "btn" }],
		["ASSISTANT_OWNER_HEIGHT_CM", { ...auth, ASSISTANT_OWNER_HEIGHT_CM: "5'10" }],
		["ASSISTANT_OWNER_HEIGHT_CM", { ...auth, ASSISTANT_OWNER_HEIGHT_CM: "1.76" }], // metres, not centimetres
		["ASSISTANT_OWNER_HEIGHT_CM", { ...auth, ASSISTANT_OWNER_HEIGHT_CM: "300" }],
		["ASSISTANT_READ_PATHS", { ...auth, ASSISTANT_READ_PATHS: "Documents" }],
		["ASSISTANT_READ_PATHS", { ...auth, ASSISTANT_READ_PATHS: "/a::/b" }],
		["ASSISTANT_READ_PATHS", { ...auth, ASSISTANT_READ_PATHS: "/" }],
		// An allowlist must not widen to the defaults because its variable is blank.
		["ASSISTANT_READ_PATHS", { ...auth, ASSISTANT_READ_PATHS: "" }],
		["ASSISTANT_READ_PATHS", { ...auth, ASSISTANT_READ_PATHS: "  " }],
	])("rejects an invalid %s", (setting, env) => {
		expect(problemsOf(env)).toStrictEqual([setting]);
	});

	it("reports every problem at once, each naming its setting and how to fix it", () => {
		let caught: unknown;
		try {
			parseConfig({ ASSISTANT_PORT: "x", ASSISTANT_READ_PATHS: "relative/dir" }, context);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ConfigError);
		const message = (caught as ConfigError).message;
		expect(message).toContain("3 problems");
		expect(message).toMatch(/ASSISTANT_PORT: 'x' is not a port number\. Use an integer from 1 to 65535/);
		expect(message).toMatch(/ASSISTANT_READ_PATHS: 'relative\/dir' is not an absolute path\. Use a full path/);
		expect(message).toMatch(/ASSISTANT_OWNER_LOGIN: is required while authentication is on/);
	});
});

describe("when follow-ups and birthdays fire", () => {
	it("defaults to a 15 minute agenda lead, a 30 minute wait before asking, and 09:00 and 18:00 for birthdays", () => {
		expect(parseConfig({ ...auth }, context).schedule).toStrictEqual({
			agendaLeadMinutes: 15,
			followupAskDelayMinutes: 30,
			birthdayRemindTime: "09:00",
			birthdayCheckTime: "18:00",
			followupReaskTime: "09:00",
			followupDefaultTime: "10:00",
		});
	});

	it("reads each setting from the environment", () => {
		const config = parseConfig(
			{
				...auth,
				ASSISTANT_AGENDA_LEAD_MINUTES: "45",
				ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES: "10",
				ASSISTANT_BIRTHDAY_REMIND_TIME: "07:30",
				ASSISTANT_BIRTHDAY_CHECK_TIME: "20:15",
				ASSISTANT_FOLLOWUP_REASK_TIME: "08:15",
				ASSISTANT_FOLLOWUP_DEFAULT_TIME: "14:00",
			},
			context,
		);

		expect(config.schedule).toStrictEqual({
			agendaLeadMinutes: 45,
			followupAskDelayMinutes: 10,
			birthdayRemindTime: "07:30",
			birthdayCheckTime: "20:15",
			followupReaskTime: "08:15",
			followupDefaultTime: "14:00",
		});
	});

	it("refuses what is not a number of minutes or a time of day, naming the setting and what to use", () => {
		for (const env of [
			{ ASSISTANT_AGENDA_LEAD_MINUTES: "0" },
			{ ASSISTANT_AGENDA_LEAD_MINUTES: "1441" },
			{ ASSISTANT_AGENDA_LEAD_MINUTES: "a quarter hour" },
			{ ASSISTANT_AGENDA_LEAD_MINUTES: "1e2" },
			{ ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES: "-5" },
			{ ASSISTANT_BIRTHDAY_REMIND_TIME: "9am" },
			{ ASSISTANT_BIRTHDAY_REMIND_TIME: "24:00" },
			{ ASSISTANT_BIRTHDAY_CHECK_TIME: "18:60" },
			{ ASSISTANT_FOLLOWUP_REASK_TIME: "9" },
			{ ASSISTANT_FOLLOWUP_DEFAULT_TIME: "noon" },
		]) {
			expect(problemsOf({ ...auth, ...env })).toStrictEqual([Object.keys(env)[0]]);
		}
		expect(() => parseConfig({ ...auth, ASSISTANT_AGENDA_LEAD_MINUTES: "0" }, context)).toThrow(
			/ASSISTANT_AGENDA_LEAD_MINUTES: '0' is not a number of minutes\. Use a whole number from 1 to 1440 \(default 15\)/,
		);
		expect(() => parseConfig({ ...auth, ASSISTANT_BIRTHDAY_REMIND_TIME: "9am" }, context)).toThrow(
			/ASSISTANT_BIRTHDAY_REMIND_TIME: '9am' is not a time of day\. Use 24-hour HH:MM/,
		);
	});

	it("wants the evening question after the morning reminder, since it asks about what the reminder was for", () => {
		expect(problemsOf({ ...auth, ASSISTANT_BIRTHDAY_REMIND_TIME: "19:00" })).toStrictEqual([
			"ASSISTANT_BIRTHDAY_CHECK_TIME",
		]);
		expect(
			problemsOf({ ...auth, ASSISTANT_BIRTHDAY_REMIND_TIME: "10:00", ASSISTANT_BIRTHDAY_CHECK_TIME: "10:00" }),
		).toStrictEqual(["ASSISTANT_BIRTHDAY_CHECK_TIME"]);
		expect(
			problemsOf({ ...auth, ASSISTANT_BIRTHDAY_REMIND_TIME: "08:00", ASSISTANT_BIRTHDAY_CHECK_TIME: "08:01" }),
		).toStrictEqual([]);
	});
});

describe("loadConfig (file system)", () => {
	const temps: string[] = [];
	afterEach(async () => {
		for (const dir of temps.splice(0)) {
			await chmod(dir, 0o700).catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function sandbox(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "assistant-config-"));
		temps.push(dir);
		return dir;
	}

	/** An environment whose data directory and read paths live under a fresh temp directory. */
	async function envIn(readFolders: string[] = ["docs"]) {
		const root = await sandbox();
		const readPaths = readFolders.map((name) => join(root, name));
		for (const path of readPaths) await mkdir(path, { recursive: true });
		const env: Env = {
			...auth,
			ASSISTANT_DATA_DIR: join(root, "data"),
			ASSISTANT_READ_PATHS: readPaths.join(":"),
		};
		return { root, env };
	}

	const settingsOf = async (env: Env): Promise<string[]> => {
		try {
			await loadConfig(env, context);
		} catch (error) {
			if (error instanceof ConfigError) return error.problems.map((problem) => problem.message);
			throw error;
		}
		return [];
	};

	it("creates the data directories, keeping secrets private even when it already exists with looser permissions", async () => {
		const { root, env } = await envIn();
		await mkdir(join(root, "data", "secrets"), { recursive: true, mode: 0o755 });
		await chmod(join(root, "data", "secrets"), 0o755);

		const config = await loadConfig(env, context);

		for (const dir of [config.paths.files, config.paths.workspace, config.paths.secrets]) {
			expect((await stat(dir)).isDirectory()).toBe(true);
		}
		expect((await stat(config.paths.secrets)).mode & 0o777).toBe(0o700);
	});

	it("tightens an existing data directory to 0700, because the databases inside are created 0644", async () => {
		const { root, env } = await envIn();
		await mkdir(join(root, "data"), { recursive: true, mode: 0o755 });
		await chmod(join(root, "data"), 0o755);

		const config = await loadConfig(env, context);

		expect((await stat(config.dataDir)).mode & 0o777).toBe(0o700);
	});

	it("resolves a symlinked data directory, so the write root and the secrets glob are the real paths", async () => {
		const { root, env } = await envIn();
		await mkdir(join(root, "disk2", "assistant"), { recursive: true });
		await symlink(join(root, "disk2"), join(root, "link"));
		const real = join(await realpath(root), "disk2", "assistant");

		const config = await loadConfig({ ...env, ASSISTANT_DATA_DIR: join(root, "link", "assistant") }, context);

		expect(config.dataDir).toBe(real);
		expect(config.paths.workspace).toBe(join(real, "workspace"));
		expect(config.writePath).toBe(join(real, "workspace"));
		expect(config.paths.secrets).toBe(join(real, "secrets"));
		expect(config.paths.credentials).toBe(join(real, "secrets", "credentials.json"));
		expect(config.paths.appDb).toBe(join(real, "app.sqlite"));
	});

	it("resolves read paths through symlinks so later checks compare real locations", async () => {
		const { root, env } = await envIn(["docs"]);
		await symlink(join(root, "docs"), join(root, "docs-link"));

		const config = await loadConfig({ ...env, ASSISTANT_READ_PATHS: join(root, "docs-link") }, context);

		expect(config.readPaths).toContain(join(await realpath(root), "docs"));
		expect(config.readPaths).not.toContain(join(root, "docs-link"));
	});

	it("names a missing read path and says how to fix it", async () => {
		const { root, env } = await envIn();

		const [message] = await settingsOf({ ...env, ASSISTANT_READ_PATHS: join(root, "nope") });

		expect(message).toContain(`${join(root, "nope")} does not exist`);
		expect(message).toContain("Create it, or set ASSISTANT_READ_PATHS");
	});

	it("rejects a read path that is a file", async () => {
		const { root, env } = await envIn();
		await writeFile(join(root, "plain.txt"), "x");

		const [message] = await settingsOf({ ...env, ASSISTANT_READ_PATHS: join(root, "plain.txt") });

		expect(message).toContain("is not a directory");
	});

	it.skipIf(process.getuid?.() === 0)("rejects a read path the user cannot read", async () => {
		const { root, env } = await envIn(["locked"]);
		await chmod(join(root, "locked"), 0o000);

		const [message] = await settingsOf(env);

		expect(message).toContain("is not readable");
	});

	it("never lets a read path expose the databases or secrets, but allows uploads and workspace", async () => {
		const { root, env } = await envIn();
		const data = join(root, "data");
		await mkdir(join(data, "files"), { recursive: true });

		expect((await settingsOf({ ...env, ASSISTANT_READ_PATHS: root }))[0]).toContain("contains the data directory");
		expect((await settingsOf({ ...env, ASSISTANT_READ_PATHS: data }))[0]).toContain("contains the data directory");
		expect((await settingsOf({ ...env, ASSISTANT_READ_PATHS: join(data, "secrets") }))[0]).toContain(
			"not under files/ or workspace/",
		);
		expect(await settingsOf({ ...env, ASSISTANT_READ_PATHS: join(data, "files") })).toStrictEqual([]);
	});

	it("fails with a clear message when the data directory cannot be created", async () => {
		const { root, env } = await envIn();
		await writeFile(join(root, "blocker"), "x");

		const [message] = await settingsOf({ ...env, ASSISTANT_DATA_DIR: join(root, "blocker", "data") });

		expect(message).toContain("cannot create or write");
		expect(message).toContain("Point ASSISTANT_DATA_DIR at a directory this user can write");
	});
});
