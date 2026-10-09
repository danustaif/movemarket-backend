// Watcher event LiveMarket (RESOLVER_SERVICE.md 2.6, SOT D20).
// - proposed: dari WebSocket eth_subscribe logs (realtime, untuk tampilan).
// - finalized: getLogs atas rentang blok yang sudah finalized. Ini juga cadangan kalau WebSocket putus
//   (event yang belum pernah terlihat dikirim proposed lalu finalized) dan pemulihan sejak DEPLOY_BLOCK.
import { SOT, liveMarketAbi } from "@movemarket/shared";
import type { Address, Hex } from "viem";
import type { ChainWatcher, LiveMarketEvent, Stop } from "../contracts.ts";

/** Bentuk log hasil decode viem (getContractEvents / watchContractEvent). */
export interface RawLog {
  eventName: string;
  args: unknown;
  transactionHash: Hex | null;
  blockNumber: bigint | null;
  logIndex: number | null;
}

export interface WatcherClient {
  getBlock(a: { blockTag: "finalized" }): Promise<{ number: bigint | null }>;
  getContractEvents(a: { address: Address; abi: typeof liveMarketAbi; fromBlock: bigint; toBlock: bigint }): Promise<readonly RawLog[]>;
}
export interface WatcherWsClient {
  watchContractEvent(a: { address: Address; abi: typeof liveMarketAbi; onLogs: (logs: RawLog[]) => void; onError?: (e: Error) => void }): () => void;
}

type Listener = (ev: LiveMarketEvent, finality: "proposed" | "finalized") => void;

export function createChainWatcher(o: {
  client: WatcherClient;
  wsClient?: WatcherWsClient;
  address: Address;
  /** Blok pertama yang dibaca (DEPLOY_BLOCK untuk pemulihan). */
  fromBlock: bigint;
  tickMs?: number;
  /** ponytail: batas range getLogs RPC tidak ada di SOT; mulai di sini, dibagi dua tiap kali ditolak. */
  maxRange?: bigint;
  onError?: (e: unknown) => void;
}): ChainWatcher & { cursor(): bigint } {
  const listeners = new Set<Listener>();
  const proposed = new Set<string>();
  const tickMs = o.tickMs ?? SOT.network.finalityMs;
  let range = o.maxRange ?? 1000n;
  let cursor = o.fromBlock - 1n; // blok finalized terakhir yang sudah diproses
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unwatch: (() => void) | undefined;

  const key = (l: RawLog) => `${l.transactionHash}:${l.logIndex}`;
  const toEvent = (l: RawLog) =>
    ({ name: l.eventName, args: l.args, txHash: l.transactionHash!, blockNumber: l.blockNumber! }) as LiveMarketEvent;
  const emit = (l: RawLog, fin: "proposed" | "finalized") => {
    const ev = toEvent(l);
    for (const fn of listeners) {
      try { fn(ev, fin); } catch (e) { o.onError?.(e); }
    }
  };

  const onWsLogs = (logs: RawLog[]) => {
    for (const l of logs) {
      if (l.blockNumber == null || l.blockNumber <= cursor) continue; // sudah lewat jalur finalized
      const k = key(l);
      if (proposed.has(k)) continue;
      proposed.add(k);
      emit(l, "proposed");
    }
  };

  const tick = async () => {
    try {
      const fin = (await o.client.getBlock({ blockTag: "finalized" })).number ?? 0n;
      while (cursor < fin && listeners.size) {
        const to = cursor + range < fin ? cursor + range : fin;
        let logs: readonly RawLog[];
        try {
          logs = await o.client.getContractEvents({ address: o.address, abi: liveMarketAbi, fromBlock: cursor + 1n, toBlock: to });
        } catch (e) {
          if (range === 1n) throw e;
          range = range / 2n;
          continue;
        }
        for (const l of logs) {
          const k = key(l);
          if (!proposed.delete(k)) emit(l, "proposed");
          emit(l, "finalized");
        }
        cursor = to;
      }
    } catch (e) {
      o.onError?.(e);
    }
    if (listeners.size) timer = setTimeout(tick, tickMs);
  };

  const start = () => {
    unwatch = o.wsClient?.watchContractEvent({
      address: o.address, abi: liveMarketAbi, onLogs: onWsLogs, onError: (e) => o.onError?.(e),
    });
    timer = setTimeout(tick, 0);
  };

  return {
    cursor: () => cursor,
    subscribe(fn): Stop {
      listeners.add(fn);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(fn);
        if (listeners.size) return;
        clearTimeout(timer);
        unwatch?.();
      };
    },
  };
}
