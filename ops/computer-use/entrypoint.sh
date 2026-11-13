#!/usr/bin/env bash
# ops/computer-use/entrypoint.sh — start the desktop inside the container (see the Dockerfile).
#
# Needs two one-time passwords in the environment, made by the host per task (run-desktop.sh):
#   ZCU_VNC_TAKEOVER   full control (the owner's "Take over")
#   ZCU_VNC_VIEW       view only (the owner watching)
# They are written to a file in /tmp (a tmpfs) and removed from the environment before anything else starts, so
# Chromium and the agent's actions never inherit them.
set -euo pipefail

if [ -z "${ZCU_VNC_TAKEOVER:-}" ] || [ -z "${ZCU_VNC_VIEW:-}" ]; then
	echo "zimpoen-desktop: ZCU_VNC_TAKEOVER and ZCU_VNC_VIEW must be set (run it through run-desktop.sh)." >&2
	exit 1
fi
[ "$ZCU_VNC_TAKEOVER" != "$ZCU_VNC_VIEW" ] ||
	{ echo "zimpoen-desktop: the takeover and view passwords must differ." >&2; exit 1; }

umask 077
# x11vnc -passwdfile: lines before __BEGIN_VIEWONLY__ get full control, lines after it view only.
printf '%s\n__BEGIN_VIEWONLY__\n%s\n' "$ZCU_VNC_TAKEOVER" "$ZCU_VNC_VIEW" >/tmp/vnc-passwords
unset ZCU_VNC_TAKEOVER ZCU_VNC_VIEW

Xvfb :1 -screen 0 1280x800x24 -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
openbox &
# VNC only on the container's loopback; the owner reaches it through websockify on 6080, which the host publishes on
# 127.0.0.1 only, behind the server's owner check.
x11vnc -display :1 -localhost -rfbport 5901 -passwdfile rm:/tmp/vnc-passwords -forever -shared -noxdamage -quiet &
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5901 &
# Chromium's own sandbox needs user namespaces gVisor does not give an unprivileged user; gVisor is the boundary here.
chromium --no-sandbox --no-first-run --disable-dev-shm-usage --user-data-dir=/tmp/chromium about:blank &

wait -n
