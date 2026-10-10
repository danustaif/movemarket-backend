// Antrian tunggal wallet resolver (RESOLVER_SERVICE.md 2.8). Satu transaksi berjalan pada satu waktu,
// sisanya diurutkan menurut prioritas jenis, FIFO di dalam jenis yang sama.
import { GAS_LIMITS, SOT, type GasLimitName } from "@movemarket/shared";
import type { TransactionReceipt } from "viem";
import type { ResolverTx, TxQueue } from "../contracts.ts";

export interface TxRequest {
  /** forwarder: forwarder mock (CRE_MODE=mock, SOT D23/D24, mockForwarderAddress). */
  target: "liveMarket" | "mockUsdc" | "forwarder";
  functionName: "lockMarkets" | "adminVoid" | "createMarkets" | "requestResolution" | "mint" | "report";
  args: readonly unknown[];
  gas: bigint;
  /** lockMarkets: priority fee lebih tinggi supaya diurutkan sebelum bet di blok yang sama. */
  urgent: boolean;
}

export type Write = (req: TxRequest) => Promise<TransactionReceipt>;
type Limits = Partial<Record<GasLimitName, number | null>>;

const PRIORITY: Record<ResolverTx["kind"], number> = {
  lockMarkets: 0, adminVoid: 1, createMarkets: 2, requestResolution: 3, creReport: 4, mint: 5,
};

function limit(limits: Limits, name: GasLimitName): bigint {
  const v = limits[name];
  if (v == null) throw new Error(`gas limit ${name} masih null di SOT gas.limits; ukur dengan eth_estimateGas dulu`);
  return BigInt(v);
}

/** Fungsi batch: base + perMarket x n (SOT bagian 13). */
const batch = (l: Limits, fn: "createMarkets" | "lockMarkets" | "requestResolution", n: number) =>
  limit(l, `${fn}Base`) + limit(l, `${fn}PerMarket`) * BigInt(n);

export function toRequest(tx: ResolverTx, l: Limits = GAS_LIMITS): TxRequest {
  switch (tx.kind) {
    case "lockMarkets":
      return { target: "liveMarket", functionName: "lockMarkets", args: [tx.ids], gas: batch(l, "lockMarkets", tx.ids.length), urgent: true };
    case "adminVoid":
      return { target: "liveMarket", functionName: "adminVoid", args: [tx.ids], gas: limit(l, "adminVoid"), urgent: false };
    case "createMarkets":
      return { target: "liveMarket", functionName: "createMarkets", args: [tx.params], gas: batch(l, "createMarkets", tx.params.length), urgent: false };
    case "requestResolution":
      return { target: "liveMarket", functionName: "requestResolution", args: [tx.gameRef, tx.ids], gas: batch(l, "requestResolution", tx.ids.length), urgent: false };
    case "creReport":
      // reportContext dan signatures diabaikan MockKeystoneForwarder dan GatedForwarder (SOT bagian 16, D24).
      return { target: "forwarder", functionName: "report", args: [tx.receiver, tx.rawReport, "0x", []], gas: BigInt(SOT.cre.gasLimit), urgent: false };
    case "mint":
      return { target: "mockUsdc", functionName: "mint", args: [tx.to, tx.amount], gas: limit(l, "mint"), urgent: false };
  }
}

const RETRYABLE = /nonce|underpriced/i;

export function createTxQueue(o: { write: Write; limits?: Limits; onRetry?: (err: unknown) => void }): TxQueue {
  type Job = { prio: number; seq: number; tx: ResolverTx; resolve: (r: TransactionReceipt) => void; reject: (e: unknown) => void };
  const jobs: Job[] = [];
  let seq = 0;
  let running = false;

  const exec = async (tx: ResolverTx) => {
    const req = toRequest(tx, o.limits);
    try {
      return await o.write(req);
    } catch (err) {
      if (!RETRYABLE.test(String((err as Error)?.message ?? err))) throw err;
      o.onRetry?.(err);
      return await o.write(req);
    }
  };

  const drain = async () => {
    if (running) return;
    running = true;
    while (jobs.length) {
      jobs.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const job = jobs.shift()!;
      await exec(job.tx).then(job.resolve, job.reject);
    }
    running = false;
  };

  return {
    send(tx) {
      return new Promise((resolve, reject) => {
        jobs.push({ prio: PRIORITY[tx.kind], seq: seq++, tx, resolve, reject });
        void drain();
      });
    },
  };
}
