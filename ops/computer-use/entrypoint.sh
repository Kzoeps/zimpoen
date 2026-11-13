#!/usr/bin/env bash
# ops/computer-use/entrypoint.sh — start the desktop inside the container (see the Dockerfile).
#
# Reads two one-time passwords from stdin, made by the host per task (run-desktop.sh): the first gives full control
# (the owner's "Take over"), the second view only. They never pass through the environment, so /proc/<pid>/environ and
# `docker inspect` don't show them. They go to a file in /tmp (a tmpfs) that x11vnc deletes once it has read it.
set -euo pipefail

IFS= read -r takeover || true
IFS= read -r view || true
exec </dev/null
if [ -z "$takeover" ] || [ -z "$view" ]; then
	echo "zimpoen-desktop: two passwords expected on stdin (run it through run-desktop.sh)." >&2
	exit 1
fi
# VNC compares only the first 8 characters.
if [ "${takeover:0:8}" = "${view:0:8}" ]; then
	echo "zimpoen-desktop: the takeover and view passwords must differ in their first 8 characters." >&2
	exit 1
fi

umask 077
# x11vnc -passwdfile: lines before __BEGIN_VIEWONLY__ get full control, lines after it view only.
printf '%s\n__BEGIN_VIEWONLY__\n%s\n' "$takeover" "$view" >/tmp/vnc-passwords
takeover=""
view=""

Xvfb :1 -screen 0 1280x800x24 -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
openbox &
# VNC only on the container's loopback; the owner reaches it through websockify on 6080, which the host publishes on
# 127.0.0.1 only, behind the server's owner check. Other containers on the network can't reach 6080: run-desktop.sh
# requires a network with inter-container traffic off.
x11vnc -display :1 -localhost -rfbport 5901 -passwdfile rm:/tmp/vnc-passwords -forever -shared -noxdamage -quiet &
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5901 &
# Chromium's own sandbox needs user namespaces gVisor does not give an unprivileged user; gVisor is the boundary here.
chromium --no-sandbox --no-first-run --disable-dev-shm-usage --user-data-dir=/tmp/chromium about:blank &

wait -n
