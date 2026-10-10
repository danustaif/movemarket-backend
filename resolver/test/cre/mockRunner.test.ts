import { describe, expect, test } from "bun:test";
import { SOT, decodeReport, gameKeyOf, liveMarketAbi, parseLichessJson, type MarketView, type Snapshot } from "@movemarket/shared";
import {
  encodeAbiParameters, encodeEventTopics, getAbiItem, size, sliceHex, type Abi, type Address, type Hex, type Log, type TransactionReceipt,
} from "viem";
import { createMockCreRunner, mockForwarderAbi, mockForwarderAddress, reportMetadata } from "../../src/cre/mockRunner.ts";
import type { ResolverTx } from "../../src/contracts.ts";
import { fixture } from "../helpers.ts";

const LIVE_MARKET = "0x00000000000000000000000000000000000000aa" as Address;
const FORWARDER = SOT.addresses.creMockKeystoneForwarder as Address;
const GAME_REF = "lichess:game:e9SJcXpJ";
const GAME_KEY = gameKeyOf(GAME_REF);
const REQUEST_TX = `0x${"ab".repeat(32)}` as Hex;
const REPORT_TX = `0x${"cd".repeat(32)}` as Hex;

/** Metadata report dari tx CLI `cre workflow simulate --broadcast` 0xb9ee7926...13c5 di Monad Testnet (109 byte). */
const CLI_METADATA =
  "0x01322c087e82728067a883e7ad51925c1c465373901c6c5c8a55efe99906826694000000640000000100000001" +
  "1111111111111111111111111111111111111111111111111111111111111111" + "66313731313765306533" +
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + "0001";

/** Log seperti di receipt: topics dari argumen indexed, data dari sisanya. */
function logOf(abi: Abi, eventName: string, args: Record<string, unknown>, address: Address): Log {
  const item = getAbiItem({ abi, name: eventName }) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const plain = item.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args } as never),
    data: encodeAbiParameters(plain, plain.map((i) => args[i.name])),
  } as Log;
}
const receiptOf = (hash: Hex, logs: Log[], status: "success" | "reverted" = "success") =>
  ({ transactionHash: hash, status, logs }) as TransactionReceipt;

const requested = (ids: bigint[], gameRef = GAME_REF) =>
  receiptOf(REQUEST_TX, [logOf(liveMarketAbi, "ResolutionRequested", { gameKey: GAME_KEY, gameRef, ids }, LIVE_MARKET)]);
const processed = (result: boolean) =>
  logOf(mockForwarderAbi, "ReportProcessed", { receiver: LIVE_MARKET, workflowExecutionId: `0x${"00".repeat(32)}`, reportId: "0x0001", result }, FORWARDER);

const view = (id: bigint, over: Partial<MarketView> = {}): MarketView => ({
  id, gameKey: GAME_KEY, marketType: 0, side: 0, fromPly: 10, toPly: 12, lockTime: 0n, status: 0, ...over,
});

function setup(o: {
  request: TransactionReceipt; views?: MarketView[]; snapshot?: Snapshot; report?: (tx: ResolverTx) => TransactionReceipt;
  /** LiveMarket.forwarder() on-chain; default sama dengan forwarder runner. */
  liveMarketForwarder?: Address;
}) {
  const sent: ResolverTx[] = [];
  const reads: unknown[] = [];
  const runner = createMockCreRunner({
    client: {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (hash !== REQUEST_TX) throw new Error(`receipt tidak dikenal ${hash}`);
        return o.request;
      },
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === "forwarder") return o.liveMarketForwarder ?? FORWARDER;
        reads.push(args);
        return o.views ?? [];
      },
    } as never,
    liveMarket: LIVE_MARKET,
    fetchSnapshot: async (gameRef) => {
      expect(gameRef).toBe(GAME_REF);
      return o.snapshot ?? parseLichessJson(JSON.parse(await fixture("game-export.finished-mate.json")));
    },
    tx: { send: async (tx) => { sent.push(tx); return o.report!(tx); } },
    nowSec: () => 1_700_000_000,
  });
  return { runner, sent, reads };
}

describe("reportMetadata", () => {
  test("109 byte, layout sama dengan report CLI cre: hanya nama workflow yang berbeda", () => {
    const execId = sliceHex(CLI_METADATA as Hex, 1, 33);
    const m = reportMetadata(execId, 100);
    expect(size(m)).toBe(109);
    // Nama workflow (byte 77..87) sengaja "mock-cre" supaya report mock bisa dibedakan dari report CLI.
    expect(sliceHex(m, 0, 77)).toBe(sliceHex(CLI_METADATA as Hex, 0, 77));
    expect(sliceHex(m, 77, 87)).toBe("0x6d6f636b2d6372650000"); // "mock-cre" + 2 byte nol
    expect(sliceHex(m, 87)).toBe(sliceHex(CLI_METADATA as Hex, 87));
  });
});

describe("mockForwarderAddress (SOT D24)", () => {
  const MOCK = "0x00000000000000000000000000000000000000f1";
  const GATED = "0x00000000000000000000000000000000000000f2";
  test("GatedForwarder kalau addresses.creGatedForwarder terisi", () => {
    expect(mockForwarderAddress({ creGatedForwarder: GATED, creMockKeystoneForwarder: MOCK })).toBe(GATED);
  });
  test("null (belum di-deploy): MockKeystoneForwarder Chainlink", () => {
    expect(mockForwarderAddress({ creGatedForwarder: null, creMockKeystoneForwarder: MOCK })).toBe(MOCK);
  });
  test("default dari SOT", () => {
    expect(mockForwarderAddress()).toBe((SOT.addresses.creGatedForwarder ?? SOT.addresses.creMockKeystoneForwarder) as Address);
  });
});

describe("createMockCreRunner", () => {
  test("resolve pasar OPEN dari export, kirim report lewat txQueue, hitung dari event LiveMarket", async () => {
    // finished-mate: 59 ply, Qxb7# di ply 59. Pasar 12 sudah RESOLVED -> dibuang sebelum report.
    const views = [view(5n, { fromPly: 59, toPly: 59 }), view(9n, { marketType: 1, fromPly: 60, toPly: 62 }), view(12n, { status: 1 })];
    const { runner, sent, reads } = setup({
      request: requested([5n, 9n, 12n]),
      views,
      report: () => receiptOf(REPORT_TX, [
        logOf(liveMarketAbi, "MarketResolved", { id: 5n, outcome: 1 }, LIVE_MARKET),
        logOf(liveMarketAbi, "MarketVoided", { id: 9n, reason: 1 }, LIVE_MARKET),
        processed(true),
      ]),
    });

    expect(await runner.run(REQUEST_TX)).toEqual({ gameRef: GAME_REF, resolved: 2, skipped: 1, txHash: REPORT_TX, note: "mock-cre" });

    expect(reads).toEqual([{ address: LIVE_MARKET, abi: liveMarketAbi, functionName: "getMarkets", args: [[5n, 9n, 12n]], blockTag: "finalized" }]);
    expect(sent).toHaveLength(1);
    const tx = sent[0]!;
    if (tx.kind !== "creReport") throw new Error(tx.kind);
    expect(tx.receiver).toBe(LIVE_MARKET);
    expect(size(tx.rawReport)).toBe(109 + 32 * 9); // head 3 + (len + 2) x 2 array
    expect(sliceHex(tx.rawReport, 33, 37)).toBe("0x6553f100"); // timestamp 1_700_000_000
    expect(decodeReport(sliceHex(tx.rawReport, 109))).toEqual({ gameKey: GAME_KEY, ids: [5n, 9n], outcomes: [1, 3] });
  });

  test("execution id unik per percobaan untuk tx request yang sama", async () => {
    const { runner, sent } = setup({
      request: requested([5n]),
      views: [view(5n, { fromPly: 59, toPly: 59 })],
      report: () => receiptOf(REPORT_TX, [processed(true)]),
    });
    await runner.run(REQUEST_TX);
    await runner.run(REQUEST_TX);
    const ids = sent.map((t) => (t.kind === "creReport" ? sliceHex(t.rawReport, 1, 33) : ""));
    expect(new Set(ids).size).toBe(2);
  });

  test("batch melebihi maxMarketsPerReport: berhenti tanpa baca chain dan tanpa tx", async () => {
    const ids = Array.from({ length: SOT.cre.maxMarketsPerReport + 1 }, (_, i) => BigInt(i + 1));
    const { runner, sent, reads } = setup({ request: requested(ids) });
    expect(await runner.run(REQUEST_TX)).toEqual({ gameRef: GAME_REF, resolved: 0, skipped: ids.length, note: "batch too large" });
    expect(reads).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("tidak ada pasar OPEN atau semua masih PENDING: tanpa tx", async () => {
    const closed = setup({ request: requested([5n]), views: [view(5n, { status: 2 })] });
    expect(await closed.runner.run(REQUEST_TX)).toEqual({ gameRef: GAME_REF, resolved: 0, skipped: 1, note: "nothing to resolve" });
    expect(closed.sent).toEqual([]);

    const ongoing = parseLichessJson(JSON.parse(await fixture("game-export.ongoing-rapid.json"))); // 44 ply, belum selesai
    const pending = setup({ request: requested([1n]), views: [view(1n, { fromPly: 45, toPly: 46 })], snapshot: ongoing });
    expect(await pending.runner.run(REQUEST_TX)).toEqual({ gameRef: GAME_REF, resolved: 0, skipped: 1, note: "nothing to resolve" });
    expect(pending.sent).toEqual([]);
  });

  test("receipt revert atau ReportProcessed.result false (onReport revert di forwarder) melempar error", async () => {
    const base = { request: requested([5n]), views: [view(5n, { fromPly: 59, toPly: 59 })] };
    const reverted = setup({ ...base, report: () => receiptOf(REPORT_TX, [], "reverted") });
    await expect(reverted.runner.run(REQUEST_TX)).rejects.toThrow(/revert/);
    const rejected = setup({ ...base, report: () => receiptOf(REPORT_TX, [processed(false)]) });
    await expect(rejected.runner.run(REQUEST_TX)).rejects.toThrow(/ReportProcessed/);
    const missing = setup({ ...base, report: () => receiptOf(REPORT_TX, []) });
    await expect(missing.runner.run(REQUEST_TX)).rejects.toThrow(/ReportProcessed/);
  });

  test("LiveMarket.forwarder() beda dengan forwarder runner: cre_forwarder_mismatch, report tidak dikirim", async () => {
    const other = "0x00000000000000000000000000000000000000f3" as Address;
    const { runner, sent } = setup({
      request: requested([5n]),
      views: [view(5n, { fromPly: 59, toPly: 59 })],
      liveMarketForwarder: other,
      report: () => receiptOf(REPORT_TX, [processed(true)]),
    });
    await expect(runner.run(REQUEST_TX)).rejects.toThrow(/cre_forwarder_mismatch.*0x00000000000000000000000000000000000000f3/);
    expect(sent).toEqual([]);
  });

  test("tx tanpa ResolutionRequested dari LiveMarket melempar error", async () => {
    const { runner } = setup({ request: receiptOf(REQUEST_TX, []) });
    await expect(runner.run(REQUEST_TX)).rejects.toThrow(/ResolutionRequested/);
  });
});
