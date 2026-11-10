#!/bin/bash
set -euo pipefail

# Stage the official rendering build for the Mac Host. Update these pins together
# with the isolated browser smoke test before moving to a new upstream version.
if [[ $# != 1 || ! -d "$1" || $(uname -sm) != "Darwin arm64" ]]; then
  echo "usage on Apple Silicon: $0 EXISTING_RELEASE_DIRECTORY" >&2
  exit 2
fi
release=$(cd -P -- "$1" && pwd)
version=0.2.6
archive_sha=19faa248ac762f466ddb822dbb03ed4f097312d10d1a4d5b2143e6040a9bebd0
license_sha=50e6751797c50dedd75ef1b8a0d9e42f5f8472e9fbce91f34718e9f97b0c780a
scratch=$(mktemp -d "$release/.obscura.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
cd "$scratch"

curl -fsSL --max-time 120 -o engine.tar.gz \
  "https://github.com/h4ckf0r0day/obscura/releases/download/v$version/obscura-aarch64-macos.tar.gz"
curl -fsSL --max-time 30 -o OBSCURA-LICENSE \
  "https://raw.githubusercontent.com/h4ckf0r0day/obscura/v$version/LICENSE"
printf '%s  %s\n' "$archive_sha" engine.tar.gz "$license_sha" OBSCURA-LICENSE | shasum -a 256 -c -
tar -xOf engine.tar.gz obscura > obscura
chmod 755 obscura
# The upstream executable is ad hoc signed. The pinned archive digest above
# authenticates the selected artifact; this checks its embedded code seal.
/usr/bin/codesign --verify --strict obscura
mv -f -- OBSCURA-LICENSE obscura "$release/"
