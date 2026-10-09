// Faucet (RESOLVER_SERVICE.md 2.9, SOT bagian 13 dan D19). Kuota di memori, cukup untuk hackathon.
// tUSDC di-mint wallet resolver (lewat txQueue), MON dikirim wallet faucet terpisah.
import { SOT, type FaucetResponse } from "@movemarket/shared";
import { isAddress, type Address, type Hex } from "viem";
import { FaucetError, type Faucet } from "../contracts.ts";

const F = SOT.faucet;
const DAY_MS = 24 * 3600 * 1000;

export interface FaucetDeps {
  usdcAmount: bigint;
  monAmountWei: bigint;
  /** Kembali setelah receipt. */
  mintUsdc(to: Address, amount: bigint): Promise<Hex>;
  /** Transfer MON dari wallet faucet, kembali setelah receipt. */
  sendMon(to: Address, value: bigint): Promise<Hex>;
  faucetBalance(): Promise<bigint>;
  balanceOf(address: Address): Promise<bigint>;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Jejak waktu per kunci dalam jendela 24 jam. */
function quota(max: number, now: () => number) {
  const hits = new Map<string, number[]>();
  const live = (k: string) => (hits.get(k) ?? []).filter((t) => now() - t < DAY_MS);
  return {
    full: (k: string) => live(k).length >= max,
    add: (k: string) => hits.set(k, [...live(k), now()]),
  };
}

export function createFaucet(d: FaucetDeps): Faucet {
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const byAddress = quota(F.perAddressPer24h, now);
  const byIp = quota(F.perIpPer24h, now);
  const gasByAddress = quota(F.gasTopUpPerAddressPer24h, now);
  const busy = new Set<string>(); // satu permintaan per alamat dalam satu waktu

  // Reserve balance: saldo faucet harus >= 10 MON + jumlah kirim (faucetWalletMinWei untuk jumlah default).
  const canSend = async (value: bigint) => {
    const floor = BigInt(F.resolverHardFloorWei) + value;
    const min = floor > BigInt(F.faucetWalletMinWei) ? floor : BigInt(F.faucetWalletMinWei);
    const bal = await d.faucetBalance();
    if (bal < min) log("faucet_low", { balance: String(bal), min: String(min) });
    return bal >= min;
  };

  const guarded = async <T>(address: string, fn: (key: string) => Promise<T>): Promise<T> => {
    if (!isAddress(address)) throw new FaucetError(400);
    const key = address.toLowerCase();
    if (busy.has(key)) throw new FaucetError(429);
    busy.add(key);
    try { return await fn(key); } finally { busy.delete(key); }
  };

  return {
    onboard: (address, ip) => guarded(address, async (key): Promise<FaucetResponse> => {
      if (byAddress.full(key) || byIp.full(ip)) throw new FaucetError(429);
      const usdcTx = await d.mintUsdc(address, d.usdcAmount);
      byIp.add(ip);
      if (!(await canSend(d.monAmountWei))) return { usdcTx, monTx: null };
      const monTx = await d.sendMon(address, d.monAmountWei);
      byAddress.add(key); // onboardingQuotaCountsOnlyIfMonSent
      return { usdcTx, monTx };
    }),

    topUpGas: (address) => guarded(address, async (key) => {
      if ((await d.balanceOf(address)) >= BigInt(F.gasTopUpThresholdWei)) throw new FaucetError(409);
      if (gasByAddress.full(key)) throw new FaucetError(429, "GAS_TOPUP_LIMIT");
      const value = BigInt(F.gasTopUpWei);
      if (!(await canSend(value))) throw new FaucetError(429, "FAUCET_FAILED");
      const monTx = await d.sendMon(address, value);
      gasByAddress.add(key);
      return { monTx };
    }),
  };
}
