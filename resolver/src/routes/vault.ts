// Route passkey backup /vault (SOT D27, bagian 12a; tipe di ResolverRoutes). GET publik (hanya ciphertext);
// POST/DELETE wajib tanda tangan EIP-191 akun atas backupMessage dengan timestamp dalam jendela waktu.
import { SOT, backupMessage, vaultId, type BackupAction, type ResolverRoutes } from "@movemarket/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isAddress, isHex, verifyMessage, type Address, type Hex } from "viem";
import { z } from "zod";
import { quota } from "../faucet/faucet.ts";
import { log as defaultLog } from "../log.ts";
import type { VaultStore } from "../vault/store.ts";
import { apiError } from "./public.ts";

const B = SOT.account.backup;

export interface VaultDeps {
  store: VaultStore;
  /** Jam dinding (detik), untuk jendela timestamp dan rate limit. */
  nowSec(): number;
  clientIp(c: Context): string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** base64url kanonik tanpa padding dengan panjang byte tertentu (atau minimal). */
const b64u = (o: { bytes?: number; min?: number }) =>
  z.string().refine((s) => {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) return false;
    const buf = Buffer.from(s, "base64url");
    return buf.toString("base64url") === s && (o.bytes === undefined || buf.length === o.bytes) && buf.length >= (o.min ?? 0);
  });

/** PasskeySecretVault Mera v1 persis; ciphertext = rahasia secretBytes + tag GCM 16 byte. */
const vaultSchema = z.strictObject({
  version: z.literal(1),
  credential: z.strictObject({
    credentialId: b64u({ min: 1 }),
    transports: z.array(z.string().max(32)).max(8).optional(),
  }),
  prfSalt: b64u({ bytes: 32 }),
  nonce: b64u({ bytes: 12 }),
  ciphertext: b64u({ bytes: B.secretBytes + 16 }),
});

const signed = {
  timestamp: z.number().int(),
  signature: z.string().refine((s) => isHex(s) && s.length === 132).transform((s) => s as Hex),
};
const addSchema = z.strictObject({
  address: z.string().refine(isAddress).transform((s) => s as Address),
  vault: z.string().refine((s) => Buffer.byteLength(s) <= B.maxVaultBytes).refine((s) => {
    try {
      return vaultSchema.safeParse(JSON.parse(s)).success;
    } catch {
      return false;
    }
  }),
  ...signed,
});
const removeSchema = z.strictObject(signed);

type Res<R extends keyof ResolverRoutes> = ResolverRoutes[R]["res"];

export function vaultRoutes(d: VaultDeps): Hono {
  const app = new Hono();
  const log = d.log ?? defaultLog;
  const writes = quota(B.writesPerIpPer24h, () => d.nowSec() * 1000);
  /** Tanda tangan yang sudah dipakai, sampai keluar dari jendela waktu (replay dalam jendela). */
  const seen = new Map<string, number>();

  /** null kalau sah (dan tanda tangan ditandai terpakai), selain itu alasan 401. */
  async function verify(action: BackupAction, address: Address, id: Hex, timestamp: number, signature: Hex): Promise<string | null> {
    const now = d.nowSec();
    if (Math.abs(now - timestamp) > B.signatureMaxAgeSec) return "timestamp di luar jendela";
    for (const [s, exp] of seen) if (exp < now) seen.delete(s);
    const key = signature.toLowerCase();
    if (seen.has(key)) return "tanda tangan sudah dipakai";
    const message = backupMessage({ action, address, vaultId: id, timestamp });
    const ok = await verifyMessage({ address, message, signature }).catch(() => false);
    if (!ok) return "tanda tangan tidak valid";
    seen.set(key, timestamp + B.signatureMaxAgeSec);
    return null;
  }

  /** Semua POST/DELETE (termasuk yang gagal) dihitung ke kuota IP. */
  const limited = (c: Context) => {
    const ip = d.clientIp(c);
    if (writes.full(ip)) return true;
    writes.take(ip);
    return false;
  };
  const body = async (c: Context) => c.req.json().catch(() => null);

  // Body berisi vault sebagai string JSON (karakter ter-escape), jadi batas kasar 2x; batas persis dicek di skema.
  app.use("*", bodyLimit({ maxSize: B.maxVaultBytes * 2, onError: (c) => apiError(c, 400, "body terlalu besar") }));

  app.get("/:address", (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return apiError(c, 400, "alamat tidak valid");
    return c.json<Res<"GET /vault/:address">>({ vaults: d.store.list(address) });
  });

  app.post("/", async (c) => {
    if (limited(c)) return apiError(c, 429, "kuota vault IP habis", "BACKUP_RATE_LIMIT");
    const p = addSchema.safeParse(await body(c));
    if (!p.success) return apiError(c, 400, "body atau vault tidak valid");
    const { address, vault, timestamp, signature } = p.data;
    const id = vaultId(vault);
    const bad = await verify("add", address, id, timestamp, signature);
    if (bad) return apiError(c, 401, bad);
    const existing = d.store.list(address);
    const same = existing.find((r) => r.id === id);
    if (same) return c.json<Res<"POST /vault">>(same);
    if (existing.length >= B.maxPerAddress) return apiError(c, 409, "batas vault per alamat", "BACKUP_LIMIT");
    const rec = { id, vault, createdAt: d.nowSec() };
    d.store.add(address, rec);
    log("vault_added", { address, id });
    return c.json<Res<"POST /vault">>(rec);
  });

  app.delete("/:address/:id", async (c) => {
    if (limited(c)) return apiError(c, 429, "kuota vault IP habis", "BACKUP_RATE_LIMIT");
    const address = c.req.param("address");
    const id = c.req.param("id").toLowerCase();
    const p = removeSchema.safeParse(await body(c));
    if (!isAddress(address) || !isHex(id) || id.length !== 66 || !p.success) return apiError(c, 400, "body atau alamat tidak valid");
    const bad = await verify("remove", address, id as Hex, p.data.timestamp, p.data.signature);
    if (bad) return apiError(c, 401, bad);
    if (!d.store.remove(address, id)) return apiError(c, 404, "vault tidak ada");
    log("vault_removed", { address, id });
    return c.json<Res<"DELETE /vault/:address/:id">>({ ok: true });
  });

  return app;
}
