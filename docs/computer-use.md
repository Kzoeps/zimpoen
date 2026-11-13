# Computer use

A disposable desktop an agent can drive, one per approved task (upgrade plan §8, phase 5). It builds on the shell
sandbox (phase 4): same base image, same gVisor hardening, same filtered network. Design and ops files only: no server
code or tool exists yet.

**Depends on the shell-sandbox feature**, which is not on this branch: `ops/shell-egress.sh` (the filtered network) and
`ZIMPOEN_SHELL_IMAGE` (the base image) come from it. Until it lands, `--network` and `BASE_IMAGE` must be made by hand.
Docker only for now (the isolation check below has no podman equivalent yet).

Files: `ops/computer-use/`.

| File | What it is |
|---|---|
| `Dockerfile` | `FROM ${BASE_IMAGE}` (the shell image, `ZIMPOEN_SHELL_IMAGE`, default `debian:stable-slim`) + Xvfb, openbox, Chromium, xdotool, scrot, x11vnc, noVNC. Runs as uid 10001, setuid bits stripped |
| `entrypoint.sh` | Starts the display, VNC on the container's loopback, websockify on 6080, Chromium |
| `run-desktop.sh` | Host side: starts one desktop for one task with the fixed hardening flags; `--dry-run` prints the argv |

```bash
docker build -t zimpoen-desktop:local ops/computer-use
printf '%s\n%s\n' "$TAKEOVER_PW" "$VIEW_PW" | \
  ops/computer-use/run-desktop.sh --task-id ct_ab12 --approval-id a_cd34 --network zimpoen-shell
# container=zimpoen-desktop-ct_ab12 viewer=127.0.0.1:49153
```

## Hardening

`--runtime=runsc`, `--read-only`, `--cap-drop=ALL`, `no-new-privileges`, memory 2 GB, 2 CPUs, 512 pids, `--pull=never`,
tmpfs for `/tmp` and the home directory, no volume and no host path (the desktop starts empty and leaves nothing), a
one-hour wall-clock stop. The network must be the filtered sandbox network from `ops/shell-egress.sh`; `host`,
`bridge`, `default` and the like are refused, and `none` is refused because the viewer then has no way in. The network
must also have inter-container traffic off (`docker network create -o com.docker.network.bridge.enable_icc=false ...`);
otherwise other sandboxes on it could reach the desktop's port 6080, and `run-desktop.sh` refuses it. The viewer
port is published on `127.0.0.1` only. The wall-clock stop targets the container id, so it never stops a later desktop
for the same task. Chromium runs with `--no-sandbox` because gVisor gives no user namespaces to an
unprivileged user; gVisor is the boundary.

## Approval per task

- A future `computer_use({ goal })` tool proposes a `pending_actions` row (action `computer_use`); nothing starts until
  the owner approves it. Proposed: it asks at every trust level, Open included, because the agent will act on live web
  pages (open question).
- The server then calls `run-desktop.sh` with the task id and approval id; the container carries both as labels. One
  desktop per task; a second start for the same task is refused.
- Refused during scheduled runs (rule 13), like bots and the broker.
- The approval covers one task. When the agent wants something outside its stated goal (a login, a purchase, a form
  submit to a third party), it stops and asks again.

## Viewer and takeover

- The server makes two random one-time passwords per task (8+ random characters each) and passes them to
  `run-desktop.sh` on stdin, which pipes them to the container's stdin as it starts (`docker create -i`, then
  `docker start -ai`). They never pass through the environment, so neither `/proc/<pid>/environ` nor `docker inspect`
  shows them. The entrypoint writes them to an x11vnc password file in `/tmp` (full control, `__BEGIN_VIEWONLY__`,
  view only) that x11vnc deletes after reading.
- VNC authentication uses only the **first 8 characters** of a password (DES). Both scripts refuse two passwords whose
  first 8 characters match, since the view password would then grant takeover. 8 random characters is the real strength;
  the outer protection is that the port is on the host's loopback behind the server's owner checks.
- The PWA shows a noVNC viewer through the server, which proxies `127.0.0.1:<port>` behind the usual owner checks
  (Tailscale identity, Host guard). Watching uses the view password.
- **Take over:** the owner presses it; the server marks the task `taken_over`, stops sending the agent's actions,
  and gives the viewer the full-control password. **Hand back** clears the flag; the agent gets a fresh screenshot and
  a note that the owner acted.
- Stop ends the container; everything in it is gone.

## Known gaps

- x11vnc holds the passwords in memory, and it runs as the same uid as Chromium and the agent's actions inside the
  container. Only matters if something could also reach the viewer port, which is on the host's loopback.
- Not built or run: the image, gVisor with Chromium and port publishing, the PWA viewer, the tool and its approval.
