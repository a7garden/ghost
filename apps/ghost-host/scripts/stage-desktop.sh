#!/bin/bash
set -euo pipefail

# Stage PC control into a Mac Host release: the signed Ghost Control bundle (the macOS privacy identity the owner
# grants once), pinned agent-desktop with its clipboard helper and license, and Geist built from a pinned commit of
# the owner's repository. Move a pin only together with the isolated PC control smoke test.
#   apps/ghost-host/scripts/stage-desktop.sh EXISTING_RELEASE_DIRECTORY VERSION SIGNING_IDENTITY
if [[ $# != 3 || ! -d "$1" || $(uname -sm) != "Darwin arm64" ]]; then
  echo "usage on Apple Silicon: $0 EXISTING_RELEASE_DIRECTORY VERSION SIGNING_IDENTITY" >&2
  exit 2
fi
release=$(cd -P -- "$1" && pwd)
version=$2
identity=$3
here=$(cd -P -- "$(dirname -- "$0")" && pwd)
agent_desktop=1.2.0
agent_desktop_sha=219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82
agent_desktop_license_sha=cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30
geist_repo=${GEIST_REPO:-$HOME/Workspace/Projects/geist}
geist_commit=f6254ccf80f6ad68c29e29daee17260431267c37
geist_version=0.5.0
scratch=$(mktemp -d "$release/.desktop.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
cd "$scratch"

curl -fsSL --max-time 120 -o agent-desktop.tar.gz \
  "https://github.com/vercel-labs/agent-desktop/releases/download/v$agent_desktop/agent-desktop-v$agent_desktop-aarch64-apple-darwin.tar.gz"
curl -fsSL --max-time 30 -o AGENT-DESKTOP-LICENSE \
  "https://raw.githubusercontent.com/vercel-labs/agent-desktop/v$agent_desktop/LICENSE"
printf '%s  %s\n' "$agent_desktop_sha" agent-desktop.tar.gz "$agent_desktop_license_sha" AGENT-DESKTOP-LICENSE | shasum -a 256 -c -
tar -xzf agent-desktop.tar.gz agent-desktop agent-desktop-macos-helper
chmod 755 agent-desktop agent-desktop-macos-helper
# Upstream binaries are ad hoc signed; the pinned archive digest authenticates them, this checks their seals.
/usr/bin/codesign --verify --strict agent-desktop
/usr/bin/codesign --verify --strict agent-desktop-macos-helper
[[ $(./agent-desktop --version) == "agent-desktop $agent_desktop" ]]

# Exactly the pinned commit, never the working tree.
mkdir geist-src
git -C "$geist_repo" archive --format=tar "$geist_commit" | tar -xf - -C geist-src
cargo build --release --locked --quiet --manifest-path geist-src/Cargo.toml --target-dir geist-target
cp geist-target/release/geist geist
chmod 755 geist
[[ $(./geist --version) == "geist $geist_version" ]]

"$here/../../ghost-control/build.sh" "$scratch" "$version" "$identity" >/dev/null
mv -f -- "Ghost Control.app" agent-desktop agent-desktop-macos-helper AGENT-DESKTOP-LICENSE geist "$release/"
