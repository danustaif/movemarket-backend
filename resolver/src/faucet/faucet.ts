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

/**
 * Jejak waktu per kunci dalam jendela 24 jam. take() mereservasi slot secara sinkron (sebelum await apa pun)
 * dan mengembalikan fungsi rollback, supaya request paralel tidak bisa melewati batas.
 */
function quota(max: number, now: () => number) {
  const hits = new Map<string, number[]>();
  const live = (k: string) => (hits.get(k) ?? []).filter((t) => now() - t < DAY_MS);
  return {
    full: (k: string) => live(k).length >= max,
    take(k: string): () => void {
      const t = now();
      hits.set(k, [...live(k), t]);
      return () => {
        const xs = hits.get(k) ?? [];
        const i = xs.indexOf(t);
        if (i >= 0) xs.splice(i, 1);
      };
    },
  };
}

export function createFaucet(d: FaucetDeps): Faucet {
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const monByAddress = quota(F.perAddressPer24h, now); // terpakai hanya kalau MON terkirim
  const mintByIp = quota(F.perIpPer24h, now);
  const gasByAddress = quota(F.gasTopUpPerAddressPer24h, now);
  // ponytail: kuota gas per IP memakai perIpPer24h; batas MON global harian belum ada (dibatasi saldo wallet faucet).
  const gasByIp = quota(F.perIpPer24h, now);
  /** tUSDC sekali per alamat per 24 jam, terpisah dari kuota MON. Retry mengembalikan usdcTx lama. */
  const minted = new Map<string, { tx: Hex; at: number }>();
  const busy = new Set<string>(); // kunci per alamat selama request

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
    if (busy.has(key)) throw new FaucetError(429, "FAUCET_FAILED");
    busy.add(key);
    try { return await fn(key); } finally { busy.delete(key); }
  };

  return {
    onboard: (address, ip) => guarded(address, async (key): Promise<FaucetResponse> => {
      if (monByAddress.full(key)) throw new FaucetError(429, "FAUCET_FAILED");
      const prev = minted.get(key);
      const prevTx = prev && now() - prev.at < DAY_MS ? prev.tx : undefined;
      if (!prevTx && mintByIp.full(ip)) throw new FaucetError(429, "FAUCET_FAILED");
      // Reservasi sinkron sebelum await; dilepas lagi kalau langkahnya tidak terjadi.
      const releaseIp = prevTx ? () => {} : mintByIp.take(ip);
      const releaseMon = monByAddress.take(key);
      let usdcTx: Hex;
      try {
        usdcTx = prevTx ?? (await d.mintUsdc(address, d.usdcAmount));
      } catch (err) {
        releaseIp();
        releaseMon();
        throw err;
      }
      if (!prevTx) minted.set(key, { tx: usdcTx, at: now() });
      try {
        if (!(await canSend(d.monAmountWei))) {
          releaseMon(); // onboardingQuotaCountsOnlyIfMonSent
          return { usdcTx, monTx: null };
        }
        return { usdcTx, monTx: await d.sendMon(address, d.monAmountWei) };
      } catch (err) {
        releaseMon();
        throw err;
      }
    }),

    topUpGas: (address, ip) => guarded(address, async (key) => {
      if (gasByAddress.full(key) || gasByIp.full(ip)) throw new FaucetError(429, "GAS_TOPUP_LIMIT");
      const releaseA = gasByAddress.take(key);
      const releaseI = gasByIp.take(ip);
      const release = () => { releaseA(); releaseI(); };
      try {
        if ((await d.balanceOf(address)) >= BigInt(F.gasTopUpThresholdWei)) throw new FaucetError(409);
        const value = BigInt(F.gasTopUpWei);
        if (!(await canSend(value))) throw new FaucetError(429, "FAUCET_FAILED");
        return { monTx: await d.sendMon(address, value) };
      } catch (err) {
        release();
        throw err;
      }
    }),
  };
}
