import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

const run = promisify(execFile);
const OPS = new URL("../../../ops/", import.meta.url).pathname;
const CHECK = join(OPS, "check.sh");
const SERVE = join(OPS, "tailscale-serve.sh");
const INSTALL = join(OPS, "install-units.sh");
const SCRIPTS = [CHECK, SERVE, INSTALL];

/**
 * ShellCheck is a system program (the Haskell binary, installed with `apt install shellcheck` or `pip install shellcheck-py`), not
 * something `pnpm install` brings: where it is missing the two tests that run it are skipped, and nothing else is, so a machine
 * without it still proves that every script parses and that its behaviour is right. A machine with it (the owner's laptop and a CI
 * image should have it) runs them, and a script that is not clean fails the suite. Shown as "skipped" in the report: that is this.
 */
const hasShellcheck = spawnSync("shellcheck", ["--version"]).status === 0;
if (!hasShellcheck) {
	console.warn(
		`ops.test.ts: shellcheck is not installed, so the ${SCRIPTS.length} shellcheck tests are skipped (apt install shellcheck, or pip install shellcheck-py).`,
	);
}

/** Run a script and return what it printed and how it ended (a non-zero exit is a result here, not an error). */
async function exec(script: string, args: string[], env: Record<string, string> = {}) {
	try {
		const { stdout } = await run("bash", [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
		return { code: 0, out: stdout };
	} catch (error) {
		const failed = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failed.code ?? -1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
	}
}

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const SECRET_REFRESH = "refresh-token-that-must-never-be-printed";

/** A data directory as a finished setup leaves it: private folders, private files, sign-ins saved, a running server's lock. */
async function dataDir(change: (dir: string) => Promise<void> = async () => {}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "assistant-ops-"));
	dirs.push(dir);
	const secrets = join(dir, "secrets");
	await mkdir(join(dir, "templates"), { recursive: true });
	await mkdir(secrets, { recursive: true });
	const put = async (name: string, value: unknown) => {
		await writeFile(join(secrets, name), JSON.stringify(value));
		await chmod(join(secrets, name), 0o600);
	};
	await put("credentials.json", { openai: { type: "oauth", access: "a", refresh: SECRET_REFRESH, expires: 1 } });
	await put("vapid.json", { publicKey: "pub", privateKey: "priv" });
	await put("google-accounts.json", {
		version: 1,
		accounts: { "a@example.com": { email: "a@example.com", refreshToken: SECRET_REFRESH, status: "ok" } },
	});
	await put("google-oauth.json", { installed: {} });
	await put("jev.json", { JEV_API_KEY: SECRET_REFRESH });
	await writeFile(join(dir, "templates", "invoice.html"), "<html></html>");
	await writeFile(join(dir, "server.lock"), JSON.stringify({ pid: process.pid, token: "t", acquiredAt: 1 }));
	await chmod(secrets, 0o700);
	await chmod(dir, 0o700);
	await change(dir);
	return dir;
}

const FILES_ONLY = ["--skip", "ports,api,web,tailscale,systemd,power"];
const checkFiles = (dir: string, env: Record<string, string> = { ASSISTANT_OWNER_LOGIN: "me@example.com" }) =>
	exec(CHECK, ["--data-dir", dir, ...FILES_ONLY], env);

/**
 * A folder of stand-ins for `tailscale` and `curl`, first on the PATH: they log every call to `calls` and answer from the
 * environment, so that the scripts' own logic is run for real and Tailscale (which is not changed by a test) is not.
 */
async function fakeBin(): Promise<{ dir: string; path: string; calls: () => Promise<string[]> }> {
	const dir = await mkdtemp(join(tmpdir(), "assistant-ops-bin-"));
	dirs.push(dir);
	const script = async (name: string, body: string) => {
		await writeFile(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
		await chmod(join(dir, name), 0o755);
	};
	await script(
		"tailscale",
		`echo "$*" >> "$FAKE_CALLS"
case "$*" in
	"status --json") echo '{"Self":{"DNSName":"box.tail1.ts.net.","UserID":7},"User":{"7":{"LoginName":"me@example.com"}}}' ;;
	"serve status --json") echo "\${FAKE_SERVE_JSON-}" ;;
	"serve status") echo "https://box.tail1.ts.net (tailnet only)" ;;
	serve\\ --bg*) if [ -n "\${FAKE_SERVE_FAILS:-}" ]; then echo "Access denied: serve config denied" >&2; exit 1; fi ;;
esac`,
	);
	await script(
		"curl",
		`echo "curl $*" >> "$FAKE_CALLS"
if [ -n "\${FAKE_CURL_EXIT:-}" ]; then exit "$FAKE_CURL_EXIT"; fi
body='{"agents":[1,2,3,4]}'
if [ -n "\${FAKE_CURL_BODY:-}" ]; then body="$FAKE_CURL_BODY"; fi
printf '%s\\n%s' "$body" "\${FAKE_CURL_CODE:-200}"`,
	);
	const log = join(dir, "calls");
	return {
		dir,
		path: `${dir}:${process.env.PATH ?? ""}`,
		calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
	};
}

/** What `tailscale serve status --json` says for a machine that serves the two mappings (the API's with or without the /api the script sets). */
const serveJson = (api = "http://127.0.0.1:3001/api", extra: Record<string, unknown> = {}): string =>
	JSON.stringify({
		TCP: { "443": { HTTPS: true } },
		Web: {
			"box.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" }, "/api": { Proxy: api } } },
		},
		...extra,
	});

describe("the scripts are well-formed", () => {
	for (const script of SCRIPTS) {
		it(`${script.split("/").pop()} parses as bash`, () => {
			expect(spawnSync("bash", ["-n", script]).status).toBe(0);
		});
		it.skipIf(!hasShellcheck)(
			`${script.split("/").pop()} is shellcheck-clean (skipped without shellcheck on the PATH)`,
			() => {
				const result = spawnSync("shellcheck", ["--shell=bash", script], { encoding: "utf8" });
				expect(result.stdout, result.stdout).toBe("");
				expect(result.status).toBe(0);
			},
		);
	}
});

describe("ops/check.sh", () => {
	it("in a dry run lists what it would check and reads and contacts nothing, even where nothing exists", async () => {
		const result = await exec(CHECK, [
			"--dry-run",
			"--data-dir",
			"/nonexistent/for/sure",
			"--env-file",
			"/nonexistent/env",
		]);

		expect(result.code).toBe(0);
		expect(result.out).toContain("Dry run");
		expect(result.out.match(/^WOULD CHECK /gm)?.length).toBeGreaterThanOrEqual(10);
		expect(result.out).not.toMatch(/^(PASS|FAIL|WARN) /m);
	});

	it("passes a finished setup, one line per check, and never prints a secret", async () => {
		const dir = await dataDir();

		const result = await checkFiles(dir);

		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain("PASS  the data directory is private (mode 700)");
		expect(result.out).toContain("PASS  every secret file is mode 600");
		expect(result.out).toContain("PASS  the OpenAI sign-in is saved");
		expect(result.out).toContain("PASS  the push keys exist");
		expect(result.out).toContain("PASS  Google accounts: 1 connected");
		expect(result.out).toContain("PASS  Jev mode");
		expect(result.out).toContain("PASS  the server is running");
		expect(result.out).toContain("All checks passed.");
		expect(result.out).not.toContain(SECRET_REFRESH);
	});

	it("says Rules mode, not a failure, when there is no Jev key", async () => {
		const dir = await dataDir((d) => rm(join(d, "secrets", "jev.json")));

		const result = await checkFiles(dir);

		expect(result.code).toBe(0);
		expect(result.out).toContain("WARN  Rules mode");
	});

	it.each([
		["a data directory others can enter", (d: string) => chmod(d, 0o755), /FAIL {2}the data directory .* has mode 755/],
		[
			"a secrets folder others can enter",
			(d: string) => chmod(join(d, "secrets"), 0o755),
			/FAIL {2}the secrets folder has mode 755/,
		],
		[
			"a credential file others can read",
			(d: string) => chmod(join(d, "secrets", "credentials.json"), 0o644),
			/FAIL {2}secrets\/credentials.json has mode 644/,
		],
		[
			"no OpenAI sign-in",
			(d: string) => rm(join(d, "secrets", "credentials.json")),
			/FAIL {2}no OpenAI sign-in: run 'pnpm login:openai'/,
		],
		[
			"a credential file without an OpenAI entry",
			(d: string) => writeFile(join(d, "secrets", "credentials.json"), "{}"),
			/FAIL {2}credentials.json has no OpenAI sign-in/,
		],
		["no push keys", (d: string) => rm(join(d, "secrets", "vapid.json")), /FAIL {2}no push keys/],
		[
			"a lock left by a process that is gone",
			(d: string) => writeFile(join(d, "server.lock"), JSON.stringify({ pid: 2_147_483_000 })),
			/FAIL {2}server.lock names a process that is gone/,
		],
		["no server at all", (d: string) => rm(join(d, "server.lock")), /FAIL {2}no server.lock/],
		[
			"a Google account that must be connected again",
			(d: string) =>
				writeFile(
					join(d, "secrets", "google-accounts.json"),
					JSON.stringify({
						version: 1,
						accounts: { "b@example.com": { email: "b@example.com", status: "needs_reconnect" } },
					}),
				),
			/FAIL {2}Google accounts: 1 connected; NEEDS TO BE CONNECTED AGAIN: b@example.com/,
		],
	])("fails %s, saying what to do, and exits 1", async (_name, change, expected) => {
		const dir = await dataDir(async (d) => {
			await change(d);
		});

		const result = await checkFiles(dir);

		expect(result.code).toBe(1);
		expect(result.out).toMatch(expected);
		expect(result.out).toMatch(/\d check\(s\) FAILED\./);
		expect(result.out).not.toContain(SECRET_REFRESH);
	});

	it("fails without the owner's login, and takes settings from an environment file without running it", async () => {
		const dir = await dataDir();
		const envFile = join(dir, "assistant.env");
		await writeFile(
			envFile,
			'ASSISTANT_OWNER_LOGIN="me@example.com"\nASSISTANT_PUBLIC_HOST=box.tail1.ts.net\n$(touch /tmp/ops-test-executed)\n',
		);

		const without = await checkFiles(dir, {});
		const withFile = await exec(CHECK, ["--data-dir", dir, ...FILES_ONLY, "--env-file", envFile]);

		expect(without.out).toMatch(/FAIL {2}ASSISTANT_OWNER_LOGIN is not set/);
		expect(withFile.code, withFile.out).toBe(0);
		expect(withFile.out).toContain("PASS  ASSISTANT_PUBLIC_HOST is set (box.tail1.ts.net)");
		expect(await readFile("/tmp/ops-test-executed").catch(() => "not run")).toBe("not run");
	});

	it("fails a port that listens on more than 127.0.0.1: the assistant must be reachable only through Tailscale Serve", async () => {
		const listen = (host: string) =>
			new Promise<number>((resolve) => {
				const server = createServer();
				servers.push(server);
				server.listen(0, host, () => resolve((server.address() as { port: number }).port));
			});
		const exposed = await listen("0.0.0.0");
		const private_ = await listen("127.0.0.1");
		const dir = await dataDir();

		const result = await exec(
			CHECK,
			[
				"--data-dir",
				dir,
				"--api-port",
				String(exposed),
				"--web-port",
				String(private_),
				"--skip",
				"api,web,tailscale,systemd,power",
			],
			{
				ASSISTANT_OWNER_LOGIN: "me@example.com",
			},
		);

		expect(result.out).toMatch(new RegExp(`FAIL  API port ${exposed} listens on more than 127.0.0.1`));
		expect(result.out).toContain(`PASS  web port ${private_} listens on 127.0.0.1 only`);
		expect(result.code).toBe(1);
	});

	it("fails a port nothing listens on", async () => {
		const dir = await dataDir();

		const result = await exec(
			CHECK,
			["--data-dir", dir, "--api-port", "1", "--web-port", "2", "--skip", "api,web,tailscale,systemd,power"],
			{
				ASSISTANT_OWNER_LOGIN: "me@example.com",
			},
		);

		expect(result.out).toContain("FAIL  nothing listens on port 1 (API)");
		expect(result.code).toBe(1);
	});

	it("refuses an option it does not know, and a group that does not exist (a typo must not skip nothing)", async () => {
		const result = await exec(CHECK, ["--frobnicate"]);
		expect(result.code).toBe(2);
		expect(result.out).toContain("Unknown option '--frobnicate'");
		for (const flag of ["--skip", "--only"]) {
			const typo = await exec(CHECK, [flag, "tailscal"]);
			expect([typo.code, typo.out], flag).toStrictEqual([
				2,
				expect.stringContaining("Unknown group 'tailscal'. The groups are: files lock host"),
			]);
		}
	});

	it("says it cannot read the environment file, once, and stops: the defaults it would use instead make every other line misleading", async () => {
		const dir = await dataDir();
		const envFile = join(dir, "assistant.env");
		await writeFile(envFile, "ASSISTANT_OWNER_LOGIN=me@example.com\n");
		await chmod(envFile, 0o000);

		const result = await exec(CHECK, ["--data-dir", dir, ...FILES_ONLY, "--env-file", envFile]);

		expect(result.code).toBe(1);
		expect(result.out).toContain(`FAIL  cannot read the environment file ${envFile}`);
		expect(result.out).toContain("1 check(s) FAILED.");
		expect(result.out).not.toMatch(/the data directory .* does not exist|ASSISTANT_OWNER_LOGIN is not set/);
	});

	it("runs only the groups asked for, so that the first steps of the checklist can use it before a server exists", async () => {
		const dir = await dataDir(async (d) => {
			await rm(join(d, "server.lock"));
			await rm(join(d, "secrets", "vapid.json"));
		});

		const result = await exec(CHECK, ["--data-dir", dir, "--only", "files"]);

		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain("PASS  the OpenAI sign-in is saved");
		// The keys are made at the server's first start: before it, that is a note and not a failure.
		expect(result.out).toContain("WARN  no push keys yet");
		expect(result.out).not.toMatch(/server\.lock|ASSISTANT_OWNER_LOGIN|listens/);
	});

	it("still fails missing push keys once the server has run", async () => {
		const dir = await dataDir((d) => rm(join(d, "secrets", "vapid.json")));

		const result = await exec(CHECK, ["--data-dir", dir, "--only", "files"]);

		expect(result.code).toBe(1);
		expect(result.out).toContain("FAIL  no push keys (vapid.json)");
	});

	it("fails the example values of the environment file: the server accepts them and the phone is then refused", async () => {
		const dir = await dataDir();
		const envFile = join(dir, "assistant.env");
		await writeFile(envFile, await readFile(join(OPS, "assistant.env.example"), "utf8"));

		const result = await exec(CHECK, ["--data-dir", dir, "--only", "host", "--env-file", envFile]);

		expect(result.code).toBe(1);
		expect(result.out).toContain("FAIL  ASSISTANT_OWNER_LOGIN is still the example value (you@example.com)");
		expect(result.out).toContain("FAIL  ASSISTANT_PUBLIC_HOST is still the example value (my-laptop.tail1234.ts.net)");
	});

	describe("through Tailscale Serve (stand-ins for tailscale and curl)", () => {
		const HOST = { ASSISTANT_OWNER_LOGIN: "me@example.com", ASSISTANT_PUBLIC_HOST: "box.tail1.ts.net" };
		const checkServe = async (env: Record<string, string>) => {
			const bin = await fakeBin();
			const dir = await dataDir();
			const result = await exec(CHECK, ["--data-dir", dir, "--only", "tailscale"], {
				...HOST,
				PATH: bin.path,
				FAKE_CALLS: join(bin.dir, "calls"),
				...env,
			});
			return { ...result, calls: await bin.calls() };
		};

		it("passes when / goes to the web app, /api to the server's /api, Funnel is off, and the API answers through Serve", async () => {
			const result = await checkServe({ FAKE_SERVE_JSON: serveJson() });

			expect(result.code, result.out).toBe(0);
			expect(result.out).toContain("PASS  tailscale serve maps / to the web app (http://127.0.0.1:3000)");
			expect(result.out).toContain("PASS  tailscale serve maps /api to the server (http://127.0.0.1:3001/api)");
			expect(result.out).toContain("PASS  Funnel is off");
			expect(result.out).toContain("PASS  https://box.tail1.ts.net/api/agents answers with four agents");
			expect(result.calls).toContain("curl -sS -m 15 -w \\n%{http_code} https://box.tail1.ts.net/api/agents");
			// It only reads: no serve or funnel command is run.
			expect(result.calls.filter((call) => /^(serve --|funnel)/.test(call))).toStrictEqual([]);
		});

		it("fails a /api that goes to the server without /api, naming the cause: the page loads and every call is a 404", async () => {
			const result = await checkServe({ FAKE_SERVE_JSON: serveJson("http://127.0.0.1:3001") });

			expect(result.code).toBe(1);
			expect(result.out).toMatch(
				/FAIL {2}tailscale serve maps \/api to http:\/\/127\.0\.0\.1:3001: Tailscale removes the \/api prefix/,
			);
		});

		it("fails Funnel being on, and a machine that serves nothing", async () => {
			const on = await checkServe({
				FAKE_SERVE_JSON: serveJson(undefined, { AllowFunnel: { "box.tail1.ts.net:443": true } }),
			});
			const nothing = await checkServe({ FAKE_SERVE_JSON: "{}" });

			expect(on.out).toMatch(/FAIL {2}Funnel is ON/);
			expect(nothing.out).toContain("FAIL  tailscale serve maps / to nothing");
			expect(nothing.out).toContain("FAIL  tailscale serve maps /api to nothing");
			expect([on.code, nothing.code]).toStrictEqual([1, 1]);
		});

		it("fails an answer through Serve that is not the list of agents, saying what each status means, and only warns when it cannot reach the name", async () => {
			const refused = await checkServe({ FAKE_SERVE_JSON: serveJson(), FAKE_CURL_CODE: "404", FAKE_CURL_BODY: "{}" });
			const unreachable = await checkServe({ FAKE_SERVE_JSON: serveJson(), FAKE_CURL_EXIT: "6" });

			expect(refused.out).toMatch(
				/FAIL {2}https:\/\/box\.tail1\.ts\.net\/api\/agents answered HTTP 404 without the agents list/,
			);
			expect(refused.code).toBe(1);
			expect(unreachable.out).toMatch(
				/WARN {2}could not reach https:\/\/box\.tail1\.ts\.net\/api\/agents from this machine \(curl exit 6\)/,
			);
			expect(unreachable.code).toBe(0);
		});
	});
});

describe("ops/tailscale-serve.sh", () => {
	it("in a dry run prints the commands: the web app at /, the API at /api, Funnel off, and the reminder about ASSISTANT_PUBLIC_HOST", async () => {
		const result = await exec(SERVE, ["--dry-run"]);

		expect(result.code).toBe(0);
		const commands = result.out.split("\n").filter((line) => line.startsWith("+ "));
		// `--set-path` removes its prefix before it forwards, so the API's target carries /api again. And nothing runs
		// `tailscale funnel`: its `off` would delete the two mappings, and Funnel is never turned on, and Serve removes it from its port.
		expect(commands).toStrictEqual([
			"+ tailscale serve --bg --https=443 http://127.0.0.1:3000",
			"+ tailscale serve --bg --https=443 --set-path=/api http://127.0.0.1:3001/api",
		]);
		expect(result.out).toContain("ASSISTANT_PUBLIC_HOST=");
		expect(result.out).toContain("https://<machine>.<tailnet>.ts.net/");
	});

	it("follows the ports it is told, and never turns Funnel on", async () => {
		const result = await exec(SERVE, ["--dry-run"], { ASSISTANT_PORT: "4001", ASSISTANT_WEB_PORT: "4000" });

		expect(result.out).toContain("http://127.0.0.1:4000");
		expect(result.out).toContain("--set-path=/api http://127.0.0.1:4001/api");
		expect(result.out).not.toMatch(/tailscale funnel/);
	});

	it("refuses an option it does not know", async () => {
		expect((await exec(SERVE, ["--apply"])).code).toBe(2);
	});

	describe("applied (a stand-in for tailscale)", () => {
		const apply = async (env: Record<string, string>) => {
			const bin = await fakeBin();
			const result = await exec(SERVE, [], { PATH: bin.path, FAKE_CALLS: join(bin.dir, "calls"), ...env });
			return { ...result, calls: await bin.calls() };
		};

		it("sets the two mappings, reads them back, never runs a funnel command, and prints the two settings the server needs", async () => {
			const result = await apply({ FAKE_SERVE_JSON: serveJson() });

			expect(result.code, result.out).toBe(0);
			expect(result.calls.filter((call) => call.startsWith("serve --bg"))).toStrictEqual([
				"serve --bg --https=443 http://127.0.0.1:3000",
				"serve --bg --https=443 --set-path=/api http://127.0.0.1:3001/api",
			]);
			expect(result.calls.some((call) => call.startsWith("funnel"))).toBe(false);
			expect(result.out).toContain("Checked: / and /api are mapped as intended, and Funnel is off.");
			expect(result.out).toContain("The assistant is at:  https://box.tail1.ts.net/");
			expect(result.out).toContain("ASSISTANT_PUBLIC_HOST=box.tail1.ts.net");
			expect(result.out).toContain("ASSISTANT_OWNER_LOGIN=me@example.com");
		});

		it("fails when what Tailscale holds is not what it set (a /api that lost its prefix, or Funnel on), saying what to do", async () => {
			const lost = await apply({ FAKE_SERVE_JSON: serveJson("http://127.0.0.1:3001") });
			const funnel = await apply({
				FAKE_SERVE_JSON: serveJson(undefined, { AllowFunnel: { "box.tail1.ts.net:443": true } }),
			});

			expect(lost.code).toBe(1);
			expect(lost.out).toContain("/api goes to http://127.0.0.1:3001, not http://127.0.0.1:3001/api");
			expect(funnel.code).toBe(1);
			expect(funnel.out).toContain("Funnel is ON");
			expect(funnel.out).toContain("tailscale funnel reset");
		});

		it("says how to allow a user to manage Tailscale when a command is refused, and stops", async () => {
			const result = await apply({ FAKE_SERVE_FAILS: "1" });

			expect(result.code).toBe(1);
			expect(result.out).toContain("sudo tailscale set --operator=");
			expect(result.calls.filter((call) => call.startsWith("serve --bg"))).toHaveLength(1);
		});
	});
});

describe("ops/install-units.sh", () => {
	const FILLED = [
		"--user",
		"alice",
		"--repo",
		"/srv/assistant",
		"--node",
		"/opt/node24/bin/node",
		"--data-dir",
		"/srv/assistant-data",
	];
	const lines = async (file: string) => (await readFile(file, "utf8")).split("\n");
	const render = async (...more: string[]) => {
		const out = await mkdtemp(join(tmpdir(), "assistant-ops-units-"));
		dirs.push(out);
		const result = await exec(INSTALL, ["--out", out, ...FILLED, ...more]);
		return { ...result, out };
	};

	it("fills in the lines marked CHANGE and nothing else, so that the units in the checkout never need editing", async () => {
		const { code, out } = await render();

		expect(code).toBe(0);
		for (const [unit, working, writable] of [
			["assistant-server.service", "/srv/assistant", "/srv/assistant-data"],
			["assistant-web.service", "/srv/assistant/apps/web", "/srv/assistant/apps/web/.next"],
		] as const) {
			const template = await lines(join(OPS, "systemd", unit));
			const filled = await lines(join(out, unit));
			expect(filled).toHaveLength(template.length);
			const changed = filled.flatMap((line, index) => (line === template[index] ? [] : [line]));
			expect(changed.map((line) => line.split("=")[0])).toStrictEqual([
				"User",
				"WorkingDirectory",
				"ExecStart",
				"ReadWritePaths",
			]);
			expect(filled).toContain("User=alice");
			expect(filled).toContain(`WorkingDirectory=${working}`);
			expect(filled).toContain(`ReadWritePaths=${writable}`);
			expect(filled.find((line) => line.startsWith("ExecStart="))).toMatch(/^ExecStart=\/opt\/node24\/bin\/node /);
			expect(filled.join("\n")).not.toContain("CHANGE_ME");
		}
	});

	it("uses the data folder the settings file names, as an absolute path: the unit may only write where the server writes", async () => {
		const settings = await mkdtemp(join(tmpdir(), "assistant-ops-env-"));
		dirs.push(settings);
		const envFile = join(settings, "assistant.env");
		const out = await mkdtemp(join(tmpdir(), "assistant-ops-units-"));
		dirs.push(out);

		await writeFile(envFile, 'ASSISTANT_OWNER_LOGIN=me@example.com\nASSISTANT_DATA_DIR="/var/lib/assistant"\n');
		await exec(INSTALL, [
			"--out",
			out,
			"--user",
			"alice",
			"--repo",
			"/srv/assistant",
			"--node",
			"/n/node",
			"--env-file",
			envFile,
		]);
		expect(await lines(join(out, "assistant-server.service"))).toContain("ReadWritePaths=/var/lib/assistant");

		await writeFile(envFile, "ASSISTANT_DATA_DIR=state\n");
		await exec(INSTALL, [
			"--out",
			out,
			"--user",
			"alice",
			"--repo",
			"/srv/assistant",
			"--node",
			"/n/node",
			"--env-file",
			envFile,
		]);
		expect(await lines(join(out, "assistant-server.service"))).toContain("ReadWritePaths=/srv/assistant/state");

		await exec(INSTALL, [
			"--out",
			out,
			"--user",
			"alice",
			"--repo",
			"/srv/assistant",
			"--node",
			"/n/node",
			"--env-file",
			join(settings, "none"),
		]);
		expect(await lines(join(out, "assistant-server.service"))).toContain("ReadWritePaths=/srv/assistant/data");
	});

	it("in a dry run prints both units and the commands, and changes nothing", async () => {
		const result = await exec(INSTALL, ["--dry-run", ...FILLED]);

		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain("--- /etc/systemd/system/assistant-server.service");
		expect(result.out).toContain("--- /etc/systemd/system/assistant-web.service");
		expect(result.out).toContain("+ sudo install -d -m 0700 -o alice /srv/assistant-data");
		expect(result.out).toContain("+ sudo systemctl enable --now assistant-server assistant-web");
		expect(result.out).toContain("User=alice");
	});

	it("refuses an option it does not know, and a Node that is not an absolute path", async () => {
		expect((await exec(INSTALL, ["--apply"])).code).toBe(2);
		const relative = await exec(INSTALL, ["--dry-run", "--node", "node"]);
		expect([relative.code, relative.out]).toStrictEqual([
			1,
			expect.stringContaining("--node must be an absolute path"),
		]);
	});
});

describe("the systemd units and the environment file", () => {
	const unit = (name: string) => readFile(join(OPS, "systemd", name), "utf8");

	for (const name of ["assistant-server.service", "assistant-web.service"]) {
		it(`${name} restarts on failure, runs in production mode and keeps the allowlisted folders readable`, async () => {
			const text = await unit(name);
			const lines = text.split("\n").filter((line) => !line.startsWith("#"));

			for (const required of [
				"Restart=on-failure",
				"Environment=NODE_ENV=production",
				"EnvironmentFile=/etc/assistant/assistant.env",
				"NoNewPrivileges=true",
				"ProtectSystem=strict",
				// `true` would hide /home, and with it the folders the assistant is allowed to read.
				"ProtectHome=read-only",
			]) {
				expect(lines, required).toContain(required);
			}
			expect(lines.some((line) => line.startsWith("WorkingDirectory="))).toBe(true);
			expect(lines.some((line) => line.startsWith("User="))).toBe(true);
			expect(text).toMatch(/# CHANGE: the (Linux |same )?user/);
			// V8 needs memory that is writable and executable.
			expect(lines).not.toContain("MemoryDenyWriteExecute=true");
			expect(lines).not.toContain("ProtectHome=true");
		});
	}

	it("starts the web app on loopback only, and the server through the built bundle", async () => {
		expect(await unit("assistant-web.service")).toMatch(/ExecStart=.*next start --hostname 127\.0\.0\.1 --port 3000/);
		expect(await unit("assistant-server.service")).toMatch(/ExecStart=.* apps\/server\/dist\/main\.js/);
	});

	it("the environment file example is a configuration the server accepts, with or without its optional lines", async () => {
		const text = await readFile(join(OPS, "assistant.env.example"), "utf8");
		const parse = (uncomment: boolean): Record<string, string> =>
			Object.fromEntries(
				text
					.split("\n")
					.map((line) => (uncomment ? line.replace(/^#(?=ASSISTANT_[A-Z_]+=)/, "") : line))
					.filter((line) => /^ASSISTANT_[A-Z_]+=/.test(line))
					.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
			);
		const context = { cwd: "/srv/assistant", homeDir: "/home/me" };

		for (const uncomment of [false, true]) {
			const env = parse(uncomment);
			expect(Object.keys(env)).toEqual(
				expect.arrayContaining(["ASSISTANT_OWNER_LOGIN", "ASSISTANT_PUBLIC_HOST", "ASSISTANT_PUSH_SUBJECT"]),
			);
			expect(() => parseConfig({ NODE_ENV: "production", ...env }, context), `uncomment=${uncomment}`).not.toThrow();
		}
		expect(Object.keys(parse(true)).length).toBeGreaterThan(Object.keys(parse(false)).length);
		expect(text).not.toMatch(/^export /m);
	});
});
