// Checks for the coding-VM and computer-use ops scripts (upgrade plan §6, §8). Nothing here provisions anything: scripts
// are parsed with `bash -n`, read as text, or run only down paths that stop before any system change (`--print`,
// `--dry-run`, refusals). Every run gets a PATH whose system tools (nft, ssh, docker, apt-get, ...) are stubs that record
// being called, and the tests assert which, if any, were.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const OPS = join(import.meta.dirname, "..");
const SCRIPTS = [
	"coding-vm/egress.sh",
	"coding-vm/provision.sh",
	"coding-vm/host-push.sh",
	"computer-use/run-desktop.sh",
	"computer-use/entrypoint.sh",
];
const read = (rel: string) => readFileSync(join(OPS, rel), "utf8");

const STUBBED = ["nft", "ssh", "docker", "podman", "apt-get", "systemctl", "curl", "useradd", "npm", "git", "tar"];
const sandbox = mkdtempSync(join(tmpdir(), "zimpoen-ops-test-"));
const stubDir = join(sandbox, "bin");
const callLog = join(sandbox, "calls.log");
execFileSync("mkdir", ["-p", stubDir]);
for (const tool of STUBBED) {
	const path = join(stubDir, tool);
	writeFileSync(path, `#!/bin/sh\necho "${tool} $*" >> "${callLog}"\nexit 97\n`);
	chmodSync(path, 0o755);
}
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function calls(): string[] {
	try {
		return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function run(rel: string, args: string[], env: Record<string, string> = {}, input = "") {
	writeFileSync(callLog, "");
	const r = spawnSync("bash", [join(OPS, rel), ...args], {
		input,
		encoding: "utf8",
		env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: sandbox, ...env },
	});
	return { code: r.status, out: r.stdout, err: r.stderr, calls: calls() };
}

describe("every ops script parses", () => {
	for (const rel of SCRIPTS) {
		it(`bash -n ${rel}`, () => {
			const r = spawnSync("bash", ["-n", join(OPS, rel)], { encoding: "utf8" });
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(read(rel).startsWith("#!/usr/bin/env bash\n")).toBe(true);
			expect(read(rel)).toMatch(/^set -euo pipefail$/m);
		});
	}

	const shellcheck = spawnSync("shellcheck", ["--version"]).status === 0;
	it.skipIf(!shellcheck)("shellcheck is clean", () => {
		const r = spawnSync("shellcheck", ["-x", ...SCRIPTS.map((s) => join(OPS, s))], { encoding: "utf8" });
		expect(r.stdout).toBe("");
	});
});

describe("coding VM egress rules", () => {
	const env = {
		ZCV_RELAY: "100.64.0.10:7443",
		ZCV_HOST_ADDRS: "192.168.1.20,100.64.0.10,fd7a:115c:a1e0::10",
		ZCV_DNS: "192.168.1.1",
	};

	it("allows the relay and DNS before dropping the zimpoen host, private, tailnet and link-local ranges", () => {
		const r = run("coding-vm/egress.sh", ["--print"], env);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.calls).toEqual([]);
		const lines = r.out.split("\n").map((l) => l.trim());
		const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
		const relay = at(/^ip daddr 100\.64\.0\.10 tcp dport 7443 accept/);
		const dns = at(/^ip daddr 192\.168\.1\.1 udp dport 53 accept/);
		const host4 = at(/^ip daddr \{ 192\.168\.1\.20,100\.64\.0\.10 \} counter drop/);
		const host6 = at(/^ip6 daddr \{ fd7a:115c:a1e0::10 \} counter drop/);
		const ranges4 = at(/^ip daddr \{ .* \} counter drop comment "private, tailnet, link-local"/);
		const ranges6 = at(/^ip6 daddr \{ .* \} counter drop comment "private, tailnet, link-local"/);
		for (const i of [relay, dns, host4, host6, ranges4, ranges6]) expect(i).toBeGreaterThan(-1);
		expect(relay).toBeLessThan(host4);
		expect(dns).toBeLessThan(ranges4);
		expect(host4).toBeLessThan(ranges4);
		for (const cidr of [
			"10.0.0.0/8",
			"172.16.0.0/12",
			"192.168.0.0/16",
			"169.254.0.0/16",
			"100.64.0.0/10",
			"127.0.0.0/8",
		]) {
			expect(lines[ranges4]).toContain(cidr);
		}
		for (const cidr of ["fc00::/7", "fe80::/10", "fd7a:115c:a1e0::/48"]) expect(lines[ranges6]).toContain(cidr);
		// Both the VM's own traffic and anything it forwards (containers) go through the same guard.
		expect(r.out).toMatch(/type filter hook output priority filter; policy accept;\s+oifname "lo" accept\s+jump guard/);
		expect(r.out).toMatch(/type filter hook forward priority filter; policy accept;\s+jump guard/);
		// Atomic replace, and the version marker --check looks for.
		expect(r.out).toContain("delete table inet zimpoen_vm_egress");
		expect(r.out).toContain('comment "zimpoen-vm-egress v1 relay=100.64.0.10:7443"');
	});

	it("takes an IPv6 relay in brackets", () => {
		const r = run("coding-vm/egress.sh", ["--print"], { ...env, ZCV_RELAY: "[fd7a:115c:a1e0::10]:7443" });
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/ip6 daddr fd7a:115c:a1e0::10 tcp dport 7443 accept/);
	});

	it.each([
		["a host name relay", { ZCV_RELAY: "board.example:7443" }, /use an IP address/],
		["a relay without a port", { ZCV_RELAY: "100.64.0.10" }, /has no port/],
		["a relay port out of range", { ZCV_RELAY: "100.64.0.10:70000" }, /port must be 1-65535/],
		["no host addresses", { ZCV_HOST_ADDRS: "" }, /ZCV_HOST_ADDRS is not set/],
		["a bad host address", { ZCV_HOST_ADDRS: "zimpoen.local" }, /not an IP address/],
		["a bad extra block", { ZCV_EXTRA_BLOCK: "10.0.0.0" }, /not a CIDR/],
	])("refuses %s", (_name, override, message) => {
		const r = run("coding-vm/egress.sh", ["--print"], { ...env, ...override });
		expect(r.code).toBe(1);
		expect(r.err).toMatch(message);
		expect(r.calls).toEqual([]);
	});

	it("--check fails closed when the table is missing, and names the fix", () => {
		const r = run("coding-vm/egress.sh", ["--check"], env); // the nft stub exits 97: no table
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/not loaded.*--apply.*Refusing/);
	});

	it("--check passes only for a table loaded for this relay", () => {
		const fakeNft = join(sandbox, "nft-listing");
		execFileSync("mkdir", ["-p", fakeNft]);
		const listing = (relay: string) =>
			`table inet zimpoen_vm_egress {\n\tcomment "zimpoen-vm-egress v1 relay=${relay}"\n\t\tip daddr { 10.0.0.0/8 } counter drop comment "private, tailnet, link-local"\n}\n`;
		const check = (relay: string) => {
			writeFileSync(join(fakeNft, "nft"), `#!/bin/sh\ncat <<'EOF'\n${listing(relay)}EOF\n`);
			chmodSync(join(fakeNft, "nft"), 0o755);
			return run("coding-vm/egress.sh", ["--check"], { ...env, PATH: `${fakeNft}:${stubDir}:/usr/bin:/bin` });
		};
		expect(check("100.64.0.10:7443").code).toBe(0);
		const other = check("100.64.0.99:7443");
		expect(other.code).toBe(1);
		expect(other.err).toMatch(/not 'zimpoen-vm-egress v1' for relay 100\.64\.0\.10:7443/);
	});
});

describe("coding VM provisioning (static, and refusals that stop before any change)", () => {
	const provision = read("coding-vm/provision.sh");
	const lead = read("coding-vm/systemd/herdr-lead.service");

	it("herdr-lead refuses to start without the egress rules", () => {
		expect(lead).toMatch(/^Requires=zimpoen-vm-egress\.service$/m);
		expect(lead).toMatch(/^ExecStartPre=\/usr\/local\/lib\/zimpoen-vm\/egress\.sh --check$/m);
		expect(lead).toMatch(/^User=CHANGE_ME$/m);
		expect(read("coding-vm/systemd/zimpoen-vm-egress.service")).toMatch(
			/^ExecStart=\/usr\/local\/lib\/zimpoen-vm\/egress\.sh --apply$/m,
		);
	});

	it("installs the pinned tools, checks checksums, and loads egress before installing them", () => {
		for (const tool of ["git", "nftables"])
			expect(provision).toMatch(new RegExp(`apt-get install[^\\n]*\\b${tool}\\b`));
		expect(provision).toMatch(/herdr hc hc-board herdr-lead/);
		expect(provision).toMatch(/pi-coding-agent@\$ZCV_PI_VERSION/);
		expect(provision).toMatch(/sha256sum --check/);
		expect(provision.indexOf("zimpoen-vm-egress.service")).toBeLessThan(provision.indexOf("== node"));
	});

	it("leaves git with no credential helper and pushes rewritten to fail", () => {
		expect(provision).toContain('git config --system credential.helper ""');
		expect(provision).toMatch(/pushInsteadOf "https:\/\/"/);
		expect(provision).toMatch(/pushInsteadOf "git@"/);
	});

	function config(extra: string, testValues: string) {
		const dir = mkdtempSync(join(sandbox, "cfg-"));
		const tv = join(dir, "test-values.env");
		writeFileSync(tv, testValues);
		const example = read("coding-vm/vm.env.example").replace(
			/^ZCV_TEST_VALUES_FILE=.*$/m,
			`ZCV_TEST_VALUES_FILE=${tv}`,
		);
		const cfg = join(dir, "vm.env");
		writeFileSync(cfg, `${example}\n${extra}\n`);
		return cfg;
	}

	it.each([
		["a GitHub token", "GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
		["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
		["an OpenAI key", "OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz"],
		["a Postgres password", "DATABASE_URL=postgres://app:hunter22@db/app"],
	])("refuses a test-values file holding %s, without echoing it", (_name, line) => {
		const r = run("coding-vm/provision.sh", ["--config", config("", `ZIMPOEN_VM_TEST_VALUES_ONLY=1\n${line}\n`)]);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/looks like it holds a real credential \(line\(s\) 2 \)/);
		expect(r.err).not.toContain(line.split("=").pop());
		expect(r.calls).toEqual([]);
	});

	it("refuses a config holding a credential", () => {
		const r = run("coding-vm/provision.sh", [
			"--config",
			config("TOKEN=github_pat_abcdefghijklmnopqrstuvwxyz", "ZIMPOEN_VM_TEST_VALUES_ONLY=1\n"),
		]);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/vm\.env looks like it holds a real credential/);
		expect(r.calls).toEqual([]);
	});

	it("the shipped examples pass the credential check", () => {
		const pattern = /SECRET_PATTERNS='([^']+)'/.exec(provision)?.[1];
		expect(pattern).toBeDefined();
		const r = spawnSync("grep", [
			"-E",
			pattern ?? "",
			join(OPS, "coding-vm/vm.env.example"),
			join(OPS, "coding-vm/test-values.env.example"),
		]);
		expect(r.status).toBe(1); // no match
		expect(read("coding-vm/test-values.env.example")).toMatch(/^ZIMPOEN_VM_TEST_VALUES_ONLY=1$/m);
	});
});

describe("host-side push", () => {
	const push = read("coding-vm/host-push.sh");
	const ok = [
		"--vm",
		"coder@coding-vm",
		"--repo-dir",
		"work/repo",
		"--branch",
		"zimpoen/fix",
		"--remote",
		"https://github.com/o/r.git",
	];
	const withArg = (flag: string, value: string) => {
		const a = [...ok];
		a[a.indexOf(flag) + 1] = value;
		return a;
	};

	it.each([
		["main", withArg("--branch", "main"), /merge_main action/],
		["master", withArg("--branch", "master"), /merge_main action/],
		["an option-like branch", withArg("--branch", "-f"), /not a plain branch name/],
		["a branch with ..", withArg("--branch", "a..b"), /not a plain branch name/],
		["a non-GitHub remote", withArg("--remote", "https://evil.example/o/r.git"), /must be https:\/\/github\.com/],
		["a token in the remote", withArg("--remote", "https://x:tok@github.com/o/r.git"), /must be https:\/\/github\.com/],
		["a repo dir escaping home", withArg("--repo-dir", "../etc"), /without '\.\.'/],
	])("refuses %s before contacting anything", (_name, args, message) => {
		const r = run("coding-vm/host-push.sh", args, {}, "test-token\n");
		expect(r.code).toBe(1);
		expect(r.err).toMatch(message);
		expect(r.calls).toEqual([]);
	});

	it("refuses to run without a token on stdin", () => {
		const r = run("coding-vm/host-push.sh", ok, {}, "");
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/no token on stdin/);
		expect(r.calls).toEqual([]);
	});

	it("copies out over ssh, never forces, and keeps the token out of argv and URLs", () => {
		expect(push).toMatch(/bundle create -/);
		expect(push).toMatch(/bundle verify/);
		const code = push
			.split("\n")
			.filter((l) => !l.trim().startsWith("#"))
			.join("\n");
		expect(code).not.toMatch(/--force|\s\+refs\//);
		expect(push).toContain('"refs/heads/$BRANCH:refs/heads/$BRANCH"');
		expect(push).toContain('GIT_ASKPASS="$WORK/askpass"');
		expect(push).toContain("core.hooksPath=/dev/null");
		// The token variable appears only where it is read, exported, checked and given to askpass.
		const uses = push.split("\n").filter((l) => l.includes("ZIMPOEN_PUSH_TOKEN") && !l.trim().startsWith("#"));
		expect(uses).toHaveLength(4);
		for (const l of uses)
			expect(l).toMatch(
				/read -r ZIMPOEN_PUSH_TOKEN|export ZIMPOEN_PUSH_TOKEN|\$\{ZIMPOEN_PUSH_TOKEN:-\}|printf '%s\\n' "\$ZIMPOEN_PUSH_TOKEN"/,
			);
	});
});

describe("computer-use desktop", () => {
	const ok = ["--task-id", "ct_ab12", "--approval-id", "a_cd34", "--network", "zimpoen-shell"];

	it("starts only with the sandbox's hardening, the filtered network and a loopback-only viewer (dry run)", () => {
		const r = run("computer-use/run-desktop.sh", [...ok, "--dry-run"]);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.calls).toEqual([]);
		for (const flag of [
			"--runtime=runsc",
			"--read-only",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--pull=never",
			"--network=zimpoen-shell",
			"127.0.0.1::6080",
			"--pids-limit=",
			"--memory=",
			"--cpus=",
			"--user=10001",
			"--label=zimpoen.approval=a_cd34",
			"--name=zimpoen-desktop-ct_ab12",
		]) {
			expect(r.out).toContain(flag);
		}
		expect(r.out).not.toMatch(/--volume|-v |--mount|--privileged|0\.0\.0\.0/);
	});

	it.each([
		["no approval id", ok.slice(0, 2).concat(ok.slice(4)), /approval-id is required/],
		["the host network", [...ok.slice(0, 5), "host"], /not allowed/],
		["no network", ok.slice(0, 4), /--network is required/],
		["network none", [...ok.slice(0, 5), "none"], /not allowed/],
		["a bad task id", ["--task-id", "-x", ...ok.slice(2)], /not a task id/],
	])("refuses %s", (_name, args, message) => {
		const r = run("computer-use/run-desktop.sh", [...args, "--dry-run"]);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(message);
		expect(r.calls).toEqual([]);
	});

	it("the image builds on the shell sandbox image and runs unprivileged", () => {
		const dockerfile = read("computer-use/Dockerfile");
		expect(dockerfile).toMatch(/^ARG BASE_IMAGE=docker\.io\/library\/debian:stable-slim$/m);
		expect(dockerfile).toMatch(/^FROM \$\{BASE_IMAGE\}$/m);
		expect(dockerfile).toMatch(/^USER 10001$/m);
		expect(dockerfile).toMatch(/x11vnc novnc websockify chromium xdotool/);
	});

	it("the entrypoint drops the viewer passwords from the environment and keeps VNC on loopback", () => {
		const entry = read("computer-use/entrypoint.sh");
		expect(entry).toContain("unset ZCU_VNC_TAKEOVER ZCU_VNC_VIEW");
		expect(entry).toContain("__BEGIN_VIEWONLY__");
		expect(entry).toMatch(/x11vnc [^\n]*-localhost/);
		expect(entry.indexOf("unset ZCU_VNC")).toBeLessThan(entry.indexOf("Xvfb :1"));
	});
});
