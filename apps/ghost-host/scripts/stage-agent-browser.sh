#!/bin/bash
set -euo pipefail

# v0.41.2: connected-target/focus guards and producer-owned snapshot attribution.
# Authenticate upstream source and dependency locks; apply the tracked native
# patch and disable only its root binary downloader. Never stage the official binary.
if [[ $# != 1 || ! -d "$1" || $(uname -sm) != "Darwin arm64" ]]; then
  echo "usage on Apple Silicon: $0 EXISTING_RELEASE_DIRECTORY" >&2
  exit 2
fi
release=$(cd -P -- "$1" && pwd)
repo=$(cd -- "$(dirname -- "$0")/../../.." && pwd)
commit=d52a5e90c372ec4710c69adc3837ac14bbd852aa
archive_sha=d210044290de66829e8170e0eef690c510c249e0719113f53df4ed239714bfa3
cache="$repo/dist/vendor/agent-browser"
archive="$cache/$commit.tar.gz"
source="$cache/agent-browser-$commit"
patch_file="$repo/apps/ghost-host/scripts/agent-browser-input-target.patch"
# Key the Cargo target directory by exact source commit + tracked patch SHA-256
# (validated lowercase hex), so stale objects from an earlier patch revision can
# never satisfy the current patch. Old target dirs are left in place; none are
# swept and there is no fallback to the previously shared target.
patch_sha=$(shasum -a 256 "$patch_file")
patch_sha=${patch_sha%% *}
if [[ ! $patch_sha =~ ^[0-9a-f]{64}$ ]]; then
  echo "tracked patch did not hash to 64 lowercase hex characters" >&2
  exit 1
fi
target="$cache/target/$commit-$patch_sha"
mkdir -p "$cache"
if [[ ! -f "$archive" ]]; then
  curl -fsSL --retry 3 --max-time 120 -o "$archive.download" \
    "https://codeload.github.com/vercel-labs/agent-browser/tar.gz/$commit"
  mv -f -- "$archive.download" "$archive"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | shasum -a 256 -c -
# Always reconstruct from authenticated source, not a previously patched tree.
rm -rf -- "$source"
tar -xzf "$archive" -C "$cache"
patch --batch --fuzz=0 -p1 -d "$source" -i "$patch_file"
cd "$source"
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("agent-browser source build requires Node >=24")'
if [[ $(corepack pnpm --version) != 11.1.3 ]]; then
  echo "agent-browser source build requires upstream pnpm 11.1.3" >&2
  exit 1
fi
# Upstream has no postinstall download-skip flag. Remove only that root lifecycle
# entry from the staged build manifest; dependency lifecycle policy stays intact.
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const file = "package.json";
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.scripts.postinstall !== "node scripts/postinstall.js") throw new Error("Unexpected upstream postinstall");
  delete pkg.scripts.postinstall;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
'
# Build the real embedded dashboard; upstream's Rust-only placeholder is not a release.
corepack pnpm install --frozen-lockfile --filter dashboard --store-dir "$cache/pnpm-store"
NEXT_TELEMETRY_DISABLED=1 corepack pnpm --dir packages/dashboard build
[[ -s packages/dashboard/out/index.html ]]
CARGO_TARGET_DIR="$target" cargo build --locked --release \
  --manifest-path cli/Cargo.toml --target aarch64-apple-darwin
cp -- "$target/aarch64-apple-darwin/release/agent-browser" "$release/agent-browser"
chmod 755 "$release/agent-browser"
printf 'agent-browser source %s; Ghost patch SHA-256: %s\n' "$commit" "$patch_sha"
printf 'cargo target dir %s\n' "$target"
