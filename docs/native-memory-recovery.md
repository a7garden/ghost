# Coordinated Ghost and native memory recovery

A detached Oxibrain backup is an immutable artifact: its `oxibrain-backup/1` manifest hashes the exact database bytes. Passing its loose `brain.db` through Ghost's normal recovery inventory re-snapshots SQLite and changes those bytes. The unchanged native manifest then correctly refuses restore. Do not rewrite that manifest or disable either verifier.

`ghost recovery pack-native-backup` preserves this artifact in a deterministic standard USTAR container. Ghost recovery treats the container as an opaque regular file. `unpack-native-backup` verifies a separately trusted SHA256, extracts into a new directory, and checks every native file against the original manifest. The native CLI remains responsible for database integrity, migrations and native restore.

This bounded packaging path supports `oxibrain-backup/1`, native ledger schemas1–19, projection version1, and **both** `include_cache:false` and `include_projection:false`. Only `brain.db`, `manifest.json`, and optional `documents.toml` are accepted. Unknown versions, schemas, fields, extra files, model caches and unsupported archive extensions are refused. The streaming total bound is512MiB; the manifest bound is1MiB. This native schema range is separate from Ghost's Host schema9–16.

## Operator sequence

Choose stopped source owners and private, canonical operator paths. These commands do not stop clients or services and do not enable restored dispatch. Existing output paths are refused.

```sh
oxibrain --dir /private/source-brain admin backup --no-projection --no-cache --out /private/native-detached
mkdir -m 700 /private/native-package
ghost recovery pack-native-backup --source /private/native-detached --destination /private/native-package/native-backup.tar
```

Save the returned `archive_sha256` with the trusted recovery request/evidence. Select `/private/native-package` as one stopped `memory-backup` root in the ordinary `ghost recovery create --request ... --destination ...` request, alongside Host/Pi/profile/registry/home/skill/artifact roots and separate PDC roots. Root roles do not alter SQLite handling; the archive is what preserves the nested artifact. Capture and verify the complete public recovery bundle using the existing inventory and stopped-owner contract.

After ordinary `ghost recovery restore --bundle ... --destination ...`, use **only the restored archive**. Verify its SHA256 against the trusted saved pin and the independently verified bundle's `native-backup/native-backup.tar` entry. Quarantine original roots before testing restored behavior.

```sh
ghost recovery unpack-native-backup --archive /private/restored/roots/native-backup/native-backup.tar --sha256 SAVED_SHA256 --destination /private/restored-detached
oxibrain --dir /private/new-brain admin restore /private/restored-detached
```

Unpacking never restores permissions, ownership, symlinks, hardlinks, directories or arbitrary paths from archive metadata. It accepts only the exact regular-file USTAR subset produced by the packer, validates the full archive digest and native BLAKE3 inventory, and publishes without clobber through a held parent directory. Inputs must be private owner-owned regular files, with descriptor-relative no-follow and inode/path binding checks. No original-root fallback or manifest rewrite occurs. Failed operations do not authorize clients or make old effects runnable.

Native backup excludes external PDC roots and rebuildable document indexes. Re-register the copied PDC roots using the intended current scoped authority. Rotate excluded credentials explicitly, rebind/accept current resources, configure a new exact memory profile revision, and adopt it through normal independent bot evaluation and activation before new dependent Work. Historical definitions, grants, source IDs and effect receipts retain their original meaning. A successful package/unpackage test is component evidence; it does not establish full bot recovery, actual restored Pi Work-session continuation or physical/operator acceptance.
