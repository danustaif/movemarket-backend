// Konfigurasi resolver dari env (RESOLVER_SERVICE.md bagian 4, ARCHITECTURE.md bagian 8).
// Default dari sot/constants.json; env hanya override. Secret tidak pernah masuk objek Config.
import { SOT, type CreMode } from "@movemarket/shared";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { ResolverConfig } from "./contracts.ts";

const R = SOT.resolver;

export interface Config extends ResolverConfig {
  /** Nama env wajib yang kosong. Tidak kosong = mode terbatas: tanpa watcher, txQueue, dan faucet. */
  missing: string[];
  replay: {
    startPly: number;
    plyIntervalSec: number;
    autoIdleMin: number;
    requiresViewer: boolean;
    viewerGraceSec: number;
  };
  requestMaxBatch: number;
  faucet: { usdcAmount: bigint; monAmountWei: bigint };
}

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const bool = (def: boolean) => z.enum(["true", "false"]).default(def ? "true" : "false").transform((v) => v === "true");
const address = z.string().refine((v) => isAddress(v), "bukan alamat").transform((v) => v as Address).optional();
const big = (def: string) => z.string().regex(/^\d+$/).default(def).transform(BigInt);

const schema = z.object({
  PORT: int(R.PORT),
  MONAD_TESTNET_RPC: z.url().default(SOT.network.rpcPublic),
  MONAD_TESTNET_WS: z.url().optional(),
  LIVE_MARKET_ADDRESS: address,
  MOCK_USDC_ADDRESS: address,
  DEPLOY_BLOCK: z.string().regex(/^\d+$/).optional(),
  CRE_MODE: z.enum(["simulate", "don", "off"]).default("simulate"),
  CRE_PROJECT_DIR: z.string().default("../cre"),
  CRE_TARGET: z.string().default("staging-settings"),
  CORS_ORIGIN: z.string().default("*"),
  REPLAY_POOL: z.string().default(""),
  REPLAY_START_PLY: int(R.REPLAY_START_PLY),
  REPLAY_PLY_INTERVAL_SEC: int(R.REPLAY_PLY_INTERVAL_SEC),
  AUTO_REPLAY_IDLE_MIN: int(R.AUTO_REPLAY_IDLE_MIN),
  AUTO_REPLAY_REQUIRES_VIEWER: bool(R.AUTO_REPLAY_REQUIRES_VIEWER),
  VIEWER_GRACE_SEC: int(R.VIEWER_GRACE_SEC),
  REQUEST_MAX_BATCH: int(R.REQUEST_MAX_BATCH),
  FAUCET_USDC_AMOUNT: big(SOT.faucet.usdcAmount),
  FAUCET_MON_AMOUNT: big(SOT.faucet.monAmountWei),
});

/** Env kosong (`X=` di .env) dianggap tidak diisi. */
function clean(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
}

/** Throw dengan pesan berisi nama env yang salah saja, tanpa nilainya. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(clean(env));
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`config tidak valid: ${names.join(", ")}`);
  }
  const e = parsed.data;
  const liveMarket = e.LIVE_MARKET_ADDRESS ?? (SOT.addresses.liveMarket as Address | null);
  const mockUsdc = e.MOCK_USDC_ADDRESS ?? (SOT.addresses.mockUsdc as Address | null);
  const deployBlock = e.DEPLOY_BLOCK ?? (SOT.addresses.deployBlock as string | number | null);
  const missing = [
    !liveMarket && "LIVE_MARKET_ADDRESS",
    !mockUsdc && "MOCK_USDC_ADDRESS",
    deployBlock == null && "DEPLOY_BLOCK",
  ].filter((x): x is string => typeof x === "string");

  return {
    port: e.PORT,
    rpcUrl: e.MONAD_TESTNET_RPC,
    wsUrl: e.MONAD_TESTNET_WS ?? "",
    // zeroAddress hanya placeholder di mode terbatas (missing tidak kosong); index.ts tidak membuat modul chain.
    liveMarket: liveMarket ?? zeroAddress,
    mockUsdc: mockUsdc ?? zeroAddress,
    deployBlock: BigInt(deployBlock ?? 0),
    creMode: e.CRE_MODE as CreMode,
    creProjectDir: e.CRE_PROJECT_DIR,
    creTarget: e.CRE_TARGET,
    corsOrigin: e.CORS_ORIGIN,
    replayPool: e.REPLAY_POOL.split(",").map((s) => s.trim()).filter(Boolean),
    missing,
    replay: {
      startPly: e.REPLAY_START_PLY,
      plyIntervalSec: e.REPLAY_PLY_INTERVAL_SEC,
      autoIdleMin: e.AUTO_REPLAY_IDLE_MIN,
      requiresViewer: e.AUTO_REPLAY_REQUIRES_VIEWER,
      viewerGraceSec: e.VIEWER_GRACE_SEC,
    },
    requestMaxBatch: e.REQUEST_MAX_BATCH,
    faucet: { usdcAmount: e.FAUCET_USDC_AMOUNT, monAmountWei: e.FAUCET_MON_AMOUNT },
  };
}

export type SecretName = "RESOLVER_PRIVATE_KEY" | "FAUCET_PRIVATE_KEY" | "ADMIN_TOKEN";

/** Dibaca saat dipakai, tidak disimpan di Config. undefined kalau kosong. */
export function secret(name: SecretName, env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** Private key 32 byte hex. Throw tanpa mencetak nilai kalau formatnya salah. */
export function privateKey(name: "RESOLVER_PRIVATE_KEY" | "FAUCET_PRIVATE_KEY", env = process.env): Hex | undefined {
  const v = secret(name, env);
  if (v === undefined) return undefined;
  const hex = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} bukan private key 32 byte hex`);
  return hex as Hex;
}
