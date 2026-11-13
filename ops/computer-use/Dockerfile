# ops/computer-use/Dockerfile — the computer-use desktop (upgrade plan §8, phase 5).
#
# It builds on the shell sandbox's image and runs under the same hardening. Depends on the shell-sandbox feature (phase 4,
# not on this branch): BASE_IMAGE should be its ZIMPOEN_SHELL_IMAGE (default debian:stable-slim) and the network its
# ops/shell-egress.sh network. Hardening: gVisor (--runtime=runsc), read-only root, no capabilities, no new privileges,
# limits, the filtered network.
# ops/computer-use/run-desktop.sh holds those flags; never `docker run` this image by hand without them.
#
#   docker build -t zimpoen-desktop:local ops/computer-use
#   docker build --build-arg BASE_IMAGE=<the shell image> -t zimpoen-desktop:local ops/computer-use
#
# Inside: a virtual X display (Xvfb), a small window manager, Chromium, xdotool/scrot for the agent's actions and
# screenshots, x11vnc + noVNC (websockify) for the owner's viewer/takeover on port 6080. Nothing here holds a credential.
ARG BASE_IMAGE=docker.io/library/debian:stable-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		xvfb openbox x11vnc novnc websockify chromium xdotool scrot fonts-dejavu-core ca-certificates dbus-x11 tini \
	&& rm -rf /var/lib/apt/lists/*

# The same unprivileged user id the shell sandbox uses for commands; no sudo, no setuid helpers kept.
RUN useradd --uid 10001 --create-home --home-dir /home/desktop --shell /usr/sbin/nologin desktop
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +

COPY --chmod=0755 entrypoint.sh /usr/local/bin/zimpoen-desktop

USER 10001
ENV HOME=/home/desktop DISPLAY=:1
WORKDIR /home/desktop
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/zimpoen-desktop"]
