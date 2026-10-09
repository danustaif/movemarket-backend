// Watcher event LiveMarket (RESOLVER_SERVICE.md 2.6, SOT D20).
// - proposed: dari receipt transaksi resolver sendiri (receipt()), dari WebSocket eth_subscribe logs, atau
//   tanpa WebSocket dari polling getLogs blok latest tiap SOT.network.blockTimeMs (untuk tampilan).
// - finalized: getLogs atas rentang blok yang sudah finalized. Ini juga cadangan kalau WebSocket putus
//   (event yang belum pernah terlihat dikirim proposed lalu finalized) dan pemulihan sejak DEPLOY_BLOCK.
import { SOT, liveMarketAbi } from "@movemarket/shared";
import { isAddressEqual, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
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
  getBlockNumber(): Promise<bigint>;
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
  /** Interval polling proposed tanpa WebSocket. */
  pollMs?: number;
  onError?: (e: unknown) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
}): ChainWatcher & { cursor(): bigint } {
  const listeners = new Set<Listener>();
  const proposed = new Set<string>();
  const tickMs = o.tickMs ?? SOT.network.finalityMs;
  let range = o.maxRange ?? 1000n;
  let cursor = o.fromBlock - 1n; // blok finalized terakhir yang sudah diproses
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pollMs = o.pollMs ?? SOT.network.blockTimeMs;
  let pollDelay = pollMs;
  let pollCursor: bigint | undefined; // blok latest terakhir yang sudah dibaca polling
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
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

  /** proposed dari WebSocket, polling, atau receipt sendiri; kunci txHash:logIndex mencegah duplikat. */
  const onProposed = (logs: readonly RawLog[]) => {
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

  /** Tanpa WebSocket: getLogs sejak blok terakhir yang dilihat sampai latest. Mulai dari head saat start. */
  const poll = async () => {
    try {
      const head = await o.client.getBlockNumber();
      if (pollCursor === undefined) pollCursor = head;
      let from = (pollCursor > cursor ? pollCursor : cursor) + 1n;
      if (head - from >= range) from = head - range + 1n; // tertinggal jauh: yang lebih lama datang lewat jalur finalized
      if (from <= head) {
        onProposed(await o.client.getContractEvents({ address: o.address, abi: liveMarketAbi, fromBlock: from, toBlock: head }));
        pollCursor = head;
      }
      pollDelay = pollMs;
    } catch (e) {
      o.onError?.(e);
      pollDelay = Math.min(pollDelay * 2, SOT.resolver.WATCHER_POLL_MAX_BACKOFF_SEC * 1000);
    }
    if (listeners.size) pollTimer = setTimeout(poll, pollDelay);
  };

  const start = () => {
    unwatch = o.wsClient?.watchContractEvent({
      address: o.address, abi: liveMarketAbi, onLogs: onProposed, onError: (e) => o.onError?.(e),
    });
    if (!o.wsClient) {
      o.log?.("watcher_polling", { pollMs });
      pollTimer = setTimeout(poll, 0);
    }
    timer = setTimeout(tick, 0);
  };

  return {
    cursor: () => cursor,
    receipt(r) {
      onProposed(parseEventLogs({ abi: liveMarketAbi, logs: r.logs.filter((l) => isAddressEqual(l.address, o.address)) }));
    },
    subscribe(fn): Stop {
      listeners.add(fn);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(fn);
        if (listeners.size) return;
        clearTimeout(timer);
        clearTimeout(pollTimer);
        unwatch?.();
      };
    },
  };
}
