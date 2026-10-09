import { describe, expect, test } from "bun:test";
import { liveMarketAbi } from "@movemarket/shared";
import { encodeAbiParameters, encodeEventTopics, type Hex, type TransactionReceipt } from "viem";
import { createChainWatcher, type RawLog } from "../../src/chain/watcher.ts";

const addr = "0x0000000000000000000000000000000000000001" as const;
const log = (block: bigint, i: number, id: bigint): RawLog => ({
  eventName: "MarketLocked", args: { id, lockTime: 100n }, transactionHash: `0x${String(i).padStart(64, "0")}`,
  blockNumber: block, logIndex: i,
});

function fakes() {
  const chain = { finalized: 0n, head: 0n, logs: [] as RawLog[], calls: [] as [bigint, bigint][], failNext: false, headFails: 0 };
  let onLogs: ((l: RawLog[]) => void) | undefined;
  const client = {
    getBlock: async () => ({ number: chain.finalized }),
    getBlockNumber: async () => {
      if (chain.headFails) { chain.headFails--; throw new Error("429"); }
      return chain.head > chain.finalized ? chain.head : chain.finalized;
    },
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

  test("receipt transaksi resolver: proposed langsung, tidak diulang oleh getLogs maupun WebSocket", async () => {
    const f = fakes();
    const seen: string[] = [];
    const w = createChainWatcher({ client: f.client, wsClient: f.ws, address: addr, fromBlock: 10n, tickMs: 2 });
    const stop = w.subscribe((ev, fin) => seen.push(`${fin}:${ev.name}:${String((ev.args as { id: bigint }).id)}`));

    const a = log(10n, 1, 7n);
    const other = "0x0000000000000000000000000000000000000002" as const; // log kontrak lain (mis. Transfer tUSDC) diabaikan
    w.receipt(receipt([{ ...a, address: addr }, { ...a, address: other, logIndex: 2 }]));
    expect(seen).toEqual(["proposed:MarketLocked:7"]); // sinkron, sebelum watcher membaca chain

    f.push([a]); // WebSocket menyusul
    f.chain.logs.push(a);
    f.chain.finalized = 10n;
    await Bun.sleep(15);
    stop();
    expect(seen).toEqual(["proposed:MarketLocked:7", "finalized:MarketLocked:7"]);
  });
});

describe("ChainWatcher tanpa WebSocket (polling)", () => {
  test("proposed dari getLogs blok latest dalam satu interval, sebelum finalized; finalized tetap sekali", async () => {
    const f = fakes();
    const seen: string[] = [];
    const logs: [string, Record<string, unknown>][] = [];
    const w = createChainWatcher({
      client: f.client, address: addr, fromBlock: 10n, tickMs: 40, pollMs: 5, log: (e, d) => void logs.push([e, d]),
    });
    const stop = w.subscribe((ev, fin) => seen.push(`${fin}:${ev.blockNumber}`));
    expect(logs).toEqual([["watcher_polling", { pollMs: 5 }]]); // peringatan mode polling saat start

    await Bun.sleep(10);
    f.chain.head = 12n;
    f.chain.logs.push(log(12n, 1, 1n));
    await Bun.sleep(15); // > satu pollMs, < tickMs
    expect(seen).toEqual(["proposed:12"]);
    // Rentang kecil: hanya sejak blok terakhir yang dilihat, tidak membaca ulang 10..12.
    const polled = f.chain.calls.filter(([, to]) => to === 12n);
    expect(polled).toEqual([[10n, 12n]]);

    f.chain.finalized = 12n;
    await Bun.sleep(60);
    stop();
    expect(seen).toEqual(["proposed:12", "finalized:12"]);
  });

  test("error RPC: polling mundur (backoff) lalu pulih", async () => {
    const f = fakes();
    const seen: string[] = [];
    const errors: unknown[] = [];
    const w = createChainWatcher({ client: f.client, address: addr, fromBlock: 10n, tickMs: 1000, pollMs: 10, onError: (e) => errors.push(e) });
    f.chain.headFails = 3;
    f.chain.head = 11n;
    const stop = w.subscribe((ev, fin) => seen.push(`${fin}:${ev.blockNumber}`));
    await Bun.sleep(40); // backoff 10 -> 20 -> 40 ms: poll di 0 dan 20 ms, berikutnya 60 (tanpa backoff: 0, 10, 20, 30)
    expect(errors.length).toBe(2);
    await Bun.sleep(130); // error ke-3 di 60 ms, pulih di 140 ms
    f.chain.head = 12n;
    f.chain.logs.push(log(12n, 1, 1n));
    await Bun.sleep(40); // interval kembali 10 ms
    stop();
    expect(errors.length).toBe(3);
    expect(seen).toEqual(["proposed:12"]);
  });
});

/** Receipt viem dengan log MarketLocked mentah (topics + data), seperti hasil writeContractSync. */
function receipt(logs: (RawLog & { address: `0x${string}` })[]): TransactionReceipt {
  return {
    logs: logs.map((l) => {
      const { id, lockTime } = l.args as { id: bigint; lockTime: bigint };
      return {
        address: l.address, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex,
        topics: encodeEventTopics({ abi: liveMarketAbi, eventName: "MarketLocked", args: { id } }) as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: "uint64" }], [lockTime]),
        blockHash: `0x${"0".repeat(64)}`, transactionIndex: 0, removed: false,
      };
    }),
  } as unknown as TransactionReceipt;
}

