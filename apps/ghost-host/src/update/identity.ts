import pkg from "../../package.json";
import { MIGRATIONS } from "../ledger/schema.ts";
import { MEMORY_FORMAT } from "../stores/memory.ts";

declare const GHOST_RELEASE_REPOSITORY: string;
declare const GHOST_RELEASE_COMMIT: string;
declare const GHOST_RELEASE_PUBKEY: string;

export const HOST_VERSION = pkg.version;
export const RELEASE_REPOSITORY = typeof GHOST_RELEASE_REPOSITORY === "undefined" ? null : GHOST_RELEASE_REPOSITORY;
export const RELEASE_COMMIT = typeof GHOST_RELEASE_COMMIT === "undefined" ? "dev" : GHOST_RELEASE_COMMIT;
export const RELEASE_PUBKEY = typeof GHOST_RELEASE_PUBKEY === "undefined" ? null : GHOST_RELEASE_PUBKEY;
export const STORAGE = `ledger-${MIGRATIONS.length}/pi-durable-${pkg.dependencies["@earendil-works/pi-durable"]}/vault-1/memory-${MEMORY_FORMAT}/browser-vault-2/connections-2`;
export const buildIdentity = { version: HOST_VERSION, commit: RELEASE_COMMIT, storage: STORAGE };
