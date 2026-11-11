import { createPublicKey, verify } from "node:crypto";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const lines = (b64: string) => Buffer.from(b64.trim(), "base64").toString("utf8").split("\n");

/** Verify both the signed bytes and minisign's authenticated trusted comment. */
export function verifyMinisign(pubkeyB64: string, sigB64: string, data: Uint8Array): boolean {
  try {
    const pk = Buffer.from(lines(pubkeyB64)[1]!, "base64");
    if (pk.length !== 42 || pk.subarray(0, 2).toString() !== "Ed") return false;
    const [, sigLine, trustedLine, globalLine] = lines(sigB64);
    if (!sigLine || !trustedLine?.startsWith("trusted comment: ") || !globalLine) return false;
    const sig = Buffer.from(sigLine, "base64");
    if (sig.length !== 74 || !sig.subarray(2, 10).equals(pk.subarray(2, 10))) return false;
    const alg = sig.subarray(0, 2).toString();
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk.subarray(10)]), format: "der", type: "spki" });
    const message = alg === "ED" ? new Bun.CryptoHasher("blake2b512").update(data).digest() : alg === "Ed" ? data : null;
    if (!message || !verify(null, message, key, sig.subarray(10))) return false;
    const trusted = trustedLine.replace(/^trusted comment: /, "");
    return verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), key, Buffer.from(globalLine, "base64"));
  } catch {
    return false;
  }
}
