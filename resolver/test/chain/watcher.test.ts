import { describe, expect, test } from "bun:test";
import { createChainWatcher, type RawLog } from "../../src/chain/watcher.ts";

const addr = "0x0000000000000000000000000000000000000001" as const;
const log = (block: bigint, i: number, id: bigint): RawLog => ({
  eventName: "MarketLocked", args: { id, lockTime: 100n }, transactionHash: `0x${String(i).padStart(64, "0")}`,
  blockNumber: block, logIndex: i,
});

function fakes() {
  const chain = { finalized: 0n, logs: [] as RawLog[], calls: [] as [bigint, bigint][], failNext: false };
  let onLogs: ((l: RawLog[]) => void) | undefined;
  const client = {
    getBlock: async () => ({ number: chain.finalized }),
    getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      chain.calls.push([fromBlock, toBlock]);
      if (chain.failNext) { chain.failNext = false; throw new Error("block range too large"); }
      return chain.logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
    },
  };
  const ws = { watchContractEvent: (a: { onLogs: (l: RawLog[]) => void }) => { onLogs = a.onLogs; return () => {}; } };
  return { chain, client, ws, push: (l: RawLog[]) => onLogs!(l) };
}

describe("ChainWatcher", () => {
  test("proposed dari WebSocket, finalized setelah blok finalized (D20), tanpa duplikat", async () => {
    const f = fakes();
    const seen: string[] = [];
    const w = createChainWatcher({ client: f.client, wsClient: f.ws, address: addr, fromBlock: 10n, tickMs: 2 });
    const stop = w.subscribe((ev, fin) => seen.push(`${fin}:${ev.name}:${ev.blockNumber}`));

    const a = log(10n, 1, 1n);
    f.chain.logs.push(a);
    f.push([a]);
    expect(seen).toEqual(["proposed:MarketLocked:10"]);

    await Bun.sleep(15); // finalized masih 0
    expect(seen).toHaveLength(1);

    f.chain.finalized = 11n;
    f.chain.logs.push(log(11n, 2, 2n)); // hanya terlihat lewat getLogs
    await Bun.sleep(15);
    f.push([a]); // WebSocket telat untuk blok yang sudah final: diabaikan
    stop();
    expect(seen).toEqual([
      "proposed:MarketLocked:10", "finalized:MarketLocked:10",
      "proposed:MarketLocked:11", "finalized:MarketLocked:11",
    ]);
  });

  test("getLogs gagal (range terlalu besar): range dibagi dua lalu lanjut", async () => {
    const f = fakes();
    f.chain.finalized = 400n;
    f.chain.failNext = true;
    f.chain.logs.push(log(399n, 1, 1n));
    const seen: string[] = [];
    const w = createChainWatcher({ client: f.client, address: addr, fromBlock: 1n, tickMs: 2, maxRange: 1000n });
    const stop = w.subscribe((ev, fin) => seen.push(`${fin}:${ev.blockNumber}`));
    await Bun.sleep(30);
    stop();
    expect(f.chain.calls[0]).toEqual([1n, 400n]);
    expect(f.chain.calls[1]).toEqual([1n, 400n]); // 1000/2 = 500 masih menutup sisa range
    expect(seen).toEqual(["proposed:399", "finalized:399"]);
  });
});
