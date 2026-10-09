import { describe, expect, test } from "bun:test";
import { SOT } from "@movemarket/shared";
import type { TransactionReceipt } from "viem";
import { createTxQueue, type TxRequest } from "../../src/chain/txQueue.ts";

const receipt = { status: "success" } as TransactionReceipt;
const limits = {
  createMarketsBase: 100_000, createMarketsPerMarket: 80_000,
  lockMarketsBase: 50_000, lockMarketsPerMarket: 10_000,
  requestResolutionBase: 60_000, requestResolutionPerMarket: 5_000,
  mint: 70_000, adminVoid: 90_000,
};
const to = "0x0000000000000000000000000000000000000001" as const;
const P = { gameRef: "g", marketType: 0, side: 0, fromPly: 1, toPly: 2, lockTime: 1n, resolveDeadline: 2n };

describe("TxQueue", () => {
  test("gas eksplisit base + perMarket x n, priority fee naik hanya untuk lockMarkets", async () => {
    const seen: TxRequest[] = [];
    const q = createTxQueue({ limits, write: async (r) => { seen.push(r); return receipt; } });
    await q.send({ kind: "lockMarkets", ids: [1n, 2n, 3n] });
    await q.send({ kind: "createMarkets", params: [P, P] });
    await q.send({ kind: "requestResolution", gameRef: "g", ids: [5n] });
    await q.send({ kind: "mint", to, amount: 7n });
    expect(seen.map((r) => [r.functionName, r.gas, r.urgent])).toEqual([
      ["lockMarkets", 80_000n, true],
      ["createMarkets", 260_000n, false],
      ["requestResolution", 65_000n, false],
      ["mint", 70_000n, false],
    ]);
    expect(seen[3]).toMatchObject({ target: "mockUsdc", args: [to, 7n] });
    expect(seen[2]).toMatchObject({ target: "liveMarket", args: ["g", [5n]] });
  });

  test("creReport (SOT D23): report(receiver, rawReport, 0x, []) di forwarder, gas cre.gasLimit", async () => {
    const seen: TxRequest[] = [];
    const q = createTxQueue({ limits, write: async (r) => { seen.push(r); return receipt; } });
    await q.send({ kind: "creReport", receiver: to, rawReport: "0x01" });
    expect(seen).toEqual([{
      target: "forwarder", functionName: "report", args: [to, "0x01", "0x", []], gas: BigInt(SOT.cre.gasLimit), urgent: false,
    }]);
  });

  test("gas SOT null: gagal dengan error jelas, tanpa write", async () => {
    let writes = 0;
    const q = createTxQueue({ limits: { ...limits, lockMarketsBase: null }, write: async () => { writes++; return receipt; } });
    await expect(q.send({ kind: "lockMarkets", ids: [1n] })).rejects.toThrow(/lockMarketsBase.*null/);
    expect(writes).toBe(0);
  });

  test("antrian tunggal berprioritas: lockMarkets > createMarkets > requestResolution > creReport > mint", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = createTxQueue({
      limits,
      write: async (r) => { order.push(r.functionName); if (order.length === 1) await gate; return receipt; },
    });
    const first = q.send({ kind: "mint", to, amount: 1n });
    await Bun.sleep(1);
    const rest = [
      q.send({ kind: "mint", to, amount: 2n }),
      q.send({ kind: "creReport", receiver: to, rawReport: "0x01" }),
      q.send({ kind: "requestResolution", gameRef: "g", ids: [1n] }),
      q.send({ kind: "createMarkets", params: [P] }),
      q.send({ kind: "lockMarkets", ids: [1n] }),
    ];
    release();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["mint", "lockMarkets", "createMarkets", "requestResolution", "report", "mint"]);
  });

  test("retry sekali untuk nonce/underpriced, tidak untuk error lain", async () => {
    let n = 0;
    const flaky = createTxQueue({ limits, write: async () => { if (n++ === 0) throw new Error("nonce too low"); return receipt; } });
    expect(await flaky.send({ kind: "mint", to, amount: 1n })).toBe(receipt);
    expect(n).toBe(2);

    let m = 0;
    const twice = createTxQueue({ limits, write: async () => { m++; throw new Error("replacement transaction underpriced"); } });
    await expect(twice.send({ kind: "mint", to, amount: 1n })).rejects.toThrow(/underpriced/);
    expect(m).toBe(2);

    let k = 0;
    const revert = createTxQueue({ limits, write: async () => { k++; throw new Error("execution reverted: NotResolver()"); } });
    await expect(revert.send({ kind: "mint", to, amount: 1n })).rejects.toThrow(/reverted/);
    expect(k).toBe(1);
  });
});
