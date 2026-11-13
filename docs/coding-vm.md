# Coding VM

The machine zimpoen hands coding work to (upgrade plan §6). It runs herdr-lead, `hc`, `hc-board`, pi and git, holds
**test values only**, and can reach nothing on the zimpoen host, the LAN or the tailnet except the board relay. Pushes
happen on the zimpoen host with the project's long-lived token (the broker injects it; it mints nothing); the token never
enters the VM.

Files: `ops/coding-vm/`. None of it has been run against a real VM yet (see "Not yet tested" below).

| File | Runs on | What it does |
|---|---|---|
| `copy-tools.sh` | zimpoen host | Copies the host's `herdr`, `hc`, `hc-board` and `herdr-lead` to a folder on the VM |
| `provision.sh` | VM, root | Installs everything, loads the firewall, creates the lead's user, installs the units |
| `egress.sh` | VM, root | Prints, loads (`--apply`) or checks (`--check`) the nftables egress rules |
| `systemd/zimpoen-vm-egress.service` | VM | Loads the rules at boot, before the network |
| `systemd/herdr-lead.service` | VM | Runs herdr-lead; `ExecStartPre=+egress.sh --check` (as root: listing nftables needs `CAP_NET_ADMIN`) refuses to start without the rules |
| `host-push.sh` | zimpoen host | Copies a branch out as a git bundle and pushes it with a token read from stdin |
| `vm.env.example`, `test-values.env.example` | | Settings and the test-values file |

## Set up

1. Make a Debian or Ubuntu VM (or a small separate box). Join it to the tailnet. In the tailnet ACLs, let the VM's tag
   reach only the relay's port on the zimpoen host; that is the second layer behind the VM's own firewall.
2. On the zimpoen host, copy the tools: `ops/coding-vm/copy-tools.sh --vm root@<vm> --dest /root/zimpoen-vm-tools`. The
   VM's firewall blocks the host, so the VM cannot fetch them; the host pushes.
3. Copy `ops/coding-vm/` to the VM, plus a filled-in `vm.env` (`ZCV_TOOLS_DIR` is the `--dest` above) and `test-values.env`.
4. `sudo ./provision.sh --config /root/vm.env --dry-run`, read it, then run without `--dry-run`. Running it again converges.

`provision.sh` refuses a config or test-values file with anything credential-shaped (GitHub, OpenAI, Slack, AWS
tokens, private keys, Postgres URLs with a password). It prints the line numbers, never the values. The test-values file
must also contain `ZIMPOEN_VM_TEST_VALUES_ONLY=1`.

Downloads are pinned: Node by version and sha256 and pi by exact version (`npm install --ignore-scripts`). herdr, `hc`,
`hc-board` and herdr-lead are the host's own copies, so they must be executables that run on the VM's CPU and OS; trust in
them is the ssh connection that carried them.

## Egress

`egress.sh` builds one nftables table, `inet zimpoen_vm_egress`, hooked on output (the VM itself) and forward
(containers it runs). In order:

1. Replies to connections made to the VM pass (the host can still ssh in).
2. The relay (`ZCV_RELAY`, IP:port) is allowed. It comes before the host drop because the relay usually runs on the host.
3. DNS to the resolvers in `ZCV_DNS` is allowed.
4. Every address of the zimpoen host (`ZCV_HOST_ADDRS`) is dropped.
5. `0/8`, `10/8`, `100.64/10` (tailnet), `127/8` off `lo`, `169.254/16` (link-local, cloud metadata), `172.16/12`,
   `192.168/16`, `::1`, `fc00::/7`, `fd7a:115c:a1e0::/48` (tailnet) and `fe80::/10` are dropped, plus `ZCV_EXTRA_BLOCK`.

The public internet stays open (package registries, git fetch). `--check` looks for the table's version marker for the
configured relay; herdr-lead does not start without it.

## Push

```text
CTO / PA ── cred_run(project, "push_branch", { branch }) ──► broker
broker: decide(trust, "routine") → read the project's stored token (repo-scoped, long-lived) → run
  host-push.sh --vm coder@coding-vm --repo-dir work/<repo> --branch <branch> --remote https://github.com/<o>/<r>.git
  with the token on stdin
host-push.sh: ssh VM "git bundle create - refs/heads/<branch>" → verify → fetch into a throwaway bare repo
  → git push (no hooks, no credential helper, token via GIT_ASKPASS env, never --force) → delete everything
```

- Refused: `main`, `master`, `HEAD`, option-like or `..` branch names, any remote that is not
  `https://github.com/<owner>/<repo>.git`, a bundle that does not verify, a non-fast-forward.
- Merging to the default branch is a separate broker action with sensitivity `merge_main`, never a VM push.
- The VM's system git has no credential helper and rewrites push URLs to an unusable one, so an agent's push fails early
  there. The real guarantee is that the VM has no token.

The token is one long-lived, repo-scoped token per project, stored like any broker secret (`<data>/secrets/broker/creds/`).
Policy entry:

```json
{ "id": "push_branch", "argv": ["/opt/zimpoen/ops/coding-vm/host-push.sh", "--vm", "coder@coding-vm",
  "--repo-dir", "work/{repo}", "--branch", "{branch}", "--remote", "https://github.com/{owner}/{repo}.git"],
  "params": { "owner": "^[A-Za-z0-9-]+$", "repo": "^[A-Za-z0-9_.-]+$", "branch": "^[A-Za-z0-9._/-]+$" },
  "inject": { "type": "stdin" }, "sensitivity": "routine", "maxOutputBytes": 4000, "timeoutMs": 120000 }
```

## Not yet tested

Only parsed, linted and run down paths that change nothing (`ops/test/coding-vm-computer-use.test.ts`). Needs a real
VM: the nftables ruleset loading and its interplay with tailscaled's own rules and MagicDNS (`100.100.100.100` must be in
`ZCV_DNS` if used), the unit order at boot, herdr-lead's real start command and settings, the copied tools running on the VM,
`host-push.sh` against a real VM and GitHub.
