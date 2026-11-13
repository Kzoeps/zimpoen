#!/usr/bin/env bash
# ops/coding-vm/host-push.sh — push a branch the coding VM made, from the zimpoen HOST, with the project's long-lived
# token (upgrade plan §6). The token never enters the VM: the commits are copied out as a git bundle, checked here,
# and pushed from a throwaway clone.
#
#   host-push.sh --vm coder@coding-vm --repo-dir work/myrepo --branch zimpoen/fix-x \
#                --remote https://github.com/owner/repo.git  < token-on-stdin
#
# Meant to be the argv of a broker action (docs/coding-vm.md, "Push"): the broker injects the project's stored,
# repo-scoped token on stdin (inject {"type":"stdin"}); this script reads one line and never prints, logs or puts it
# in a URL or argv. It refuses:
#   - main, master and HEAD (merging to main is a separate merge_main action, never a push from the VM)
#   - a branch name that is not [A-Za-z0-9._/-] or starts with '-'
#   - a remote that is not https://github.com/<owner>/<repo>.git
#   - a bundle that fails 'git bundle verify' or lacks the branch
#   - a non-fast-forward (no --force, ever)
#   --dry-run   do everything except the final push (still needs the token on stdin, which it discards)
set -euo pipefail

VM=""
REPO_DIR=""
BRANCH=""
REMOTE=""
DRY_RUN=0

while [ $# -gt 0 ]; do
	case "$1" in
		--vm) VM="${2:-}"; shift ;;
		--repo-dir) REPO_DIR="${2:-}"; shift ;;
		--branch) BRANCH="${2:-}"; shift ;;
		--remote) REMOTE="${2:-}"; shift ;;
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			sed -n '2,/^set -euo pipefail$/{/^#/p}' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "Unknown option '$1'. Try --help." >&2
			exit 2
			;;
	esac
	shift
done

die() {
	echo "host-push.sh: $1" >&2
	exit 1
}

[[ "$VM" =~ ^[a-z][a-z0-9-]*@[A-Za-z0-9.-]+$ ]] || die "--vm must be user@host, got '$VM'."
if ! [[ "$REPO_DIR" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ && "$REPO_DIR" != *..* ]]; then
	die "--repo-dir must be a path under the VM user's home without '..', got '$REPO_DIR'."
fi
if ! [[ "$BRANCH" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ && "$BRANCH" != *..* ]]; then
	die "--branch '$BRANCH' is not a plain branch name."
fi
case "$BRANCH" in
	main | master | HEAD) die "refusing to push '$BRANCH': merges to the default branch are a merge_main action, not a VM push." ;;
esac
[[ "$REMOTE" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]] ||
	die "--remote must be https://github.com/<owner>/<repo>.git, got '$REMOTE'."

# The token: one line on stdin. A plain (unexported) shell variable: ssh and the bundle steps never see it; only the
# final push gets it, in its own environment, for GIT_ASKPASS.
IFS= read -r TOKEN || true
[ -n "${TOKEN:-}" ] || die "no token on stdin. The broker passes the project's token on stdin."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 0700 "$WORK"

# Copy out: the VM writes a bundle of just this branch to stdout. Fixed remote command, arguments quoted for the remote shell.
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -T "$VM" \
	"git -C $(printf '%q' "$REPO_DIR") bundle create - $(printf '%q' "refs/heads/$BRANCH")" >"$WORK/branch.bundle" ||
	die "could not copy the branch out of the VM (ssh $VM, git bundle create)."

# Git without hooks, credential helpers or exotic transports; the user's ~/.gitconfig is not read.
g() {
	HOME="$WORK" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git \
		-c core.hooksPath=/dev/null -c credential.helper= -c protocol.ext.allow=never -c protocol.allow=user \
		-c protocol.https.allow=always -c protocol.file.allow=always "$@"
}

g init --quiet --bare "$WORK/repo.git"
g -C "$WORK/repo.git" bundle verify --quiet "$WORK/branch.bundle" >/dev/null 2>&1 || die "the bundle from the VM does not verify."
g -C "$WORK/repo.git" fetch --quiet --no-tags "$WORK/branch.bundle" "refs/heads/$BRANCH:refs/heads/$BRANCH" ||
	die "the bundle has no branch '$BRANCH'."

cat >"$WORK/askpass" <<'EOF'
#!/bin/sh
case "$1" in
	Username*) echo "x-access-token" ;;
	*) printf '%s\n' "$ZIMPOEN_PUSH_TOKEN" ;;
esac
EOF
chmod 0700 "$WORK/askpass"

if [ "$DRY_RUN" -eq 1 ]; then
	echo "host-push.sh: dry run; would push refs/heads/$BRANCH ($(g -C "$WORK/repo.git" rev-parse --short "refs/heads/$BRANCH")) to $REMOTE."
	exit 0
fi

# No '+' in the refspec and no --force: a non-fast-forward is refused by the remote.
ZIMPOEN_PUSH_TOKEN="$TOKEN" GIT_ASKPASS="$WORK/askpass" g -C "$WORK/repo.git" push --quiet --no-verify "$REMOTE" "refs/heads/$BRANCH:refs/heads/$BRANCH" ||
	die "push of '$BRANCH' to $REMOTE failed (non-fast-forward, expired token, or no access)."
echo "host-push.sh: pushed $BRANCH to $REMOTE."
