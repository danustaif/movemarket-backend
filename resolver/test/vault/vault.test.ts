// Route /vault (SOT D27, bagian 12a) lewat HTTP: tanda tangan, replay, format, batas, rate limit, persistensi.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SOT, backupMessage, vaultId, type BackupVaultDto } from "@movemarket/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { vaultRoutes } from "../../src/routes/vault.ts";
import { createVaultStore } from "../../src/vault/store.ts";

const B = SOT.account.backup;
const owner = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const b64u = (n: number, fill = 1) => Buffer.alloc(n, fill).toString("base64url");

/** Vault Mera v1 yang valid secara struktur (ciphertext = 32 byte rahasia + tag 16). */
const vault = (seed = 1, extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1,
  credential: { credentialId: b64u(16, seed), transports: ["hybrid", "internal"] },
  prfSalt: b64u(32, seed), nonce: b64u(12, seed), ciphertext: b64u(B.secretBytes + 16, seed),
  ...extra,
});

let dir: string;
let now: number;
let app: ReturnType<typeof vaultRoutes>;
const make = () => vaultRoutes({ store: createVaultStore(dir), nowSec: () => now, clientIp: () => "9.9.9.9" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vault-"));
  now = 1_790_000_000;
  app = make();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function addBody(v = vault(), o: { signer?: typeof owner; timestamp?: number; address?: Hex } = {}) {
  const address = o.address ?? owner.address;
  const timestamp = o.timestamp ?? now;
  const signature = await (o.signer ?? owner).signMessage({ message: backupMessage({ action: "add", address, vaultId: vaultId(v), timestamp }) });
  return { address, vault: v, timestamp, signature };
}
async function removeBody(id: Hex, o: { signer?: typeof owner; timestamp?: number } = {}) {
  const timestamp = o.timestamp ?? now;
  const signature = await (o.signer ?? owner).signMessage({ message: backupMessage({ action: "remove", address: owner.address, vaultId: id, timestamp }) });
  return { timestamp, signature };
}
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (body: unknown) => send("POST", "/", body);
const list = async (a = app) => ((await (await a.request(`/${owner.address}`)).json()) as { vaults: BackupVaultDto[] }).vaults;

describe("POST /vault", () => {
  test("signed by the account: stored, listed by GET, id = vaultId(vault)", async () => {
    const v = vault();
    const res = await post(await addBody(v));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: vaultId(v), vault: v, createdAt: now });
    expect(await list()).toEqual([{ id: vaultId(v), vault: v, createdAt: now }]);
  });

  test("signature from another key for this address: 401, nothing stored", async () => {
    const res = await post(await addBody(vault(), { signer: other }));
    expect(res.status).toBe(401);
    expect(await list()).toEqual([]);
  });

  test("valid signature but for another address: 401", async () => {
    const body = await addBody(vault(), { signer: other, address: other.address });
    expect((await post({ ...body, address: owner.address })).status).toBe(401);
  });

  test("timestamp outside signatureMaxAgeSec (old or future): 401", async () => {
    expect((await post(await addBody(vault(), { timestamp: now - B.signatureMaxAgeSec - 1 }))).status).toBe(401);
    expect((await post(await addBody(vault(), { timestamp: now + B.signatureMaxAgeSec + 1 }))).status).toBe(401);
    expect(await list()).toEqual([]);
  });

  test("replay: the same signed body cannot re-add a removed vault", async () => {
    const body = await addBody();
    expect((await post(body)).status).toBe(200);
    const id = vaultId(body.vault);
    expect((await send("DELETE", `/${owner.address}/${id}`, await removeBody(id))).status).toBe(200);
    expect((await post(body)).status).toBe(401);
    expect(await list()).toEqual([]);
  });

  test("format: unknown key, wrong ciphertext length, oversized, non-JSON: 400", async () => {
    expect((await post(await addBody(vault(1, { extra: "x" })))).status).toBe(400);
    expect((await post(await addBody(vault(1, { ciphertext: b64u(B.secretBytes + 17) })))).status).toBe(400);
    expect((await post(await addBody(vault(1, { version: 2 })))).status).toBe(400);
    const big = vault(1, { credential: { credentialId: b64u(B.maxVaultBytes) } });
    expect((await post(await addBody(big))).status).toBe(400);
    expect((await post(await addBody("not json"))).status).toBe(400);
    expect(await list()).toEqual([]);
  });

  test(`at most maxPerAddress (${B.maxPerAddress}) vaults: next one 409 BACKUP_LIMIT; same vault again is idempotent`, async () => {
    for (let i = 1; i <= B.maxPerAddress; i++) expect((await post(await addBody(vault(i)))).status).toBe(200);
    now += 1; // tanda tangan baru untuk vault yang sudah ada
    expect((await post(await addBody(vault(1)))).status).toBe(200);
    const res = await post(await addBody(vault(99)));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("BACKUP_LIMIT");
    expect((await list()).length).toBe(B.maxPerAddress);
  });

  test(`rate limit: writesPerIpPer24h (${B.writesPerIpPer24h}) writes per IP, then 429 BACKUP_RATE_LIMIT`, async () => {
    for (let i = 0; i < B.writesPerIpPer24h; i++) await post({ bad: true });
    const res = await post(await addBody());
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe("BACKUP_RATE_LIMIT");
    now += 24 * 3600 + 1;
    expect((await post(await addBody())).status).toBe(200);
  });
});

describe("DELETE /vault/:address/:id", () => {
  test("signed remove deletes; wrong signer 401; unknown id 404", async () => {
    const body = await addBody();
    await post(body);
    const id = vaultId(body.vault);
    expect((await send("DELETE", `/${owner.address}/${id}`, await removeBody(id, { signer: other }))).status).toBe(401);
    expect((await list()).length).toBe(1);
    expect((await send("DELETE", `/${owner.address}/${id}`, await removeBody(id))).status).toBe(200);
    expect(await list()).toEqual([]);
    now += 1;
    expect((await send("DELETE", `/${owner.address}/${id}`, await removeBody(id))).status).toBe(404);
  });
});

describe("GET /vault/:address and persistence", () => {
  test("invalid address 400; unknown address empty list", async () => {
    expect((await app.request("/0x123")).status).toBe(400);
    expect(await list()).toEqual([]);
  });

  test("store rebuilt from the file after restart keeps vaults (atomic write leaves no tmp file)", async () => {
    const body = await addBody();
    await post(body);
    const restarted = make();
    expect((await list(restarted)).map((r) => r.id)).toEqual([vaultId(body.vault)]);
    expect(Array.from(new Bun.Glob("*").scanSync(dir))).toEqual([B.storageFile]);
  });
});
