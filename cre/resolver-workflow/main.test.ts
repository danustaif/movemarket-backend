// Uji handler lewat runtime uji CRE SDK (tanpa WASM): EVM dan HTTP di-mock, konsensus dan report memakai default SDK.
import { describe, expect } from "bun:test";
import { decodeReport, liveMarketAbi } from "@movemarket/shared";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import { addContractMock, EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { bytesToHex, encodeAbiParameters, hexToBytes, parseAbiParameters } from "viem";
import type { Config } from "./logic";
import { initWorkflow, onResolutionRequested } from "./main";

const MONAD_TESTNET_SELECTOR = 2183018362218727504n; // `cre workflow supported-chains`, 10 Okt 2026
const LIVE_MARKET = "0x1111111111111111111111111111111111111111";
const GAME_REF = "lichess:game:e9SJcXpJ";
const GAME_KEY = "0xf7d3f3f6514378c5b767be2d036c18b0aa5bba84ae50a0bfdaad7591841aef1f"; // sot/test-vectors.json
const TOPIC0 = "0xee0a59e1d791944ec08c9b8362a29a47dea1e8b5c268d11762fbbd929632a586";
const EXPORT_URL = "https://lichess.org/game/export/e9SJcXpJ?moves=true&clocks=false&evals=false&opening=false";
const TX_HASH = `0x${"ab".repeat(32)}` as const;
const REPORT_METADATA_LEN = 109;

const baseConfig: Config = {
  mode: "onchain",
  chainSelectorName: "monad-testnet",
  liveMarketAddress: LIVE_MARKET,
  gasLimit: "1000000",
  maxMarketsPerReport: 8,
  lichessBaseUrl: "https://lichess.org",
};

// game-export.finished-mate.json: 59 ply, selesai, ply 59 = Qxb7#.
const body = await Bun.file(new URL("../../../source/sot/fixtures/lichess/game-export.finished-mate.json", import.meta.url)).text();

const log = (ids: bigint[]) =>
  ({
    topics: [hexToBytes(TOPIC0), hexToBytes(GAME_KEY)],
    data: hexToBytes(encodeAbiParameters(parseAbiParameters("string, uint256[]"), [GAME_REF, ids])),
  }) as never;

const view = (id: bigint, over: object = {}) => ({
  id, gameKey: GAME_KEY, marketType: 0, side: 0, fromPly: 59, toPly: 59, lockTime: 0n, status: 0, ...over,
});

function setup(config: Config) {
  const runtime = newTestRuntime<Config>(null, {}, config);
  const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR);
  const market = addContractMock(evm, { address: LIVE_MARKET, abi: liveMarketAbi });
  const seen = { getMarkets: [] as unknown[], urls: [] as string[], writes: [] as { report: Uint8Array; gasLimit: string }[] };
  market.getMarkets = (ids) => {
    seen.getMarkets.push(ids);
    // 5: OPEN, YES (skak mat ply 59). 6: sudah RESOLVED. 7: OPEN, VOID (ply setelah partai selesai).
    return [view(5n), view(6n, { status: 1 }), view(7n, { marketType: 1, fromPly: 60, toPly: 61 })];
  };
  market.writeReport = (input) => {
    seen.writes.push({ report: input.report.rawReport, gasLimit: input.gasConfig.gasLimit.toString() });
    return { txStatus: "TX_STATUS_SUCCESS", txHash: Buffer.from(hexToBytes(TX_HASH)).toString("base64") };
  };
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    seen.urls.push(req.url);
    return { statusCode: 200, body: Buffer.from(body).toString("base64") };
  };
  return { runtime, seen };
}

describe("onResolutionRequested", () => {
  test("onchain: resolve pasar OPEN, tulis satu report dengan gasLimit dari config", () => {
    const { runtime, seen } = setup(baseConfig);

    const out = JSON.parse(onResolutionRequested(runtime, log([5n, 6n, 7n])));

    expect(out).toEqual({ gameRef: GAME_REF, resolved: 2, skipped: 1, txHash: TX_HASH });
    expect(seen.urls).toEqual([EXPORT_URL]);
    expect(seen.writes).toHaveLength(1);
    expect(seen.writes[0]!.gasLimit).toBe("1000000");
    const payload = bytesToHex(seen.writes[0]!.report.slice(REPORT_METADATA_LEN));
    expect(decodeReport(payload)).toEqual({ gameKey: GAME_KEY, ids: [5n, 7n], outcomes: [1, 3] });
  });

  test("local-simulation: fetch dan konsensus jalan, berhenti sebelum report", () => {
    const { runtime, seen } = setup({ ...baseConfig, mode: "local-simulation" });

    const out = JSON.parse(onResolutionRequested(runtime, log([5n, 6n, 7n])));

    expect(out).toEqual({ gameRef: GAME_REF, resolved: 2, skipped: 1, mode: "local-simulation", note: "5:1,7:3" });
    expect(seen.urls).toHaveLength(1);
    expect(seen.writes).toHaveLength(0);
  });

  test("batch lebih dari maxMarketsPerReport: berhenti tanpa membaca kontrak", () => {
    const { runtime, seen } = setup({ ...baseConfig, maxMarketsPerReport: 2 });

    const out = JSON.parse(onResolutionRequested(runtime, log([5n, 6n, 7n])));

    expect(out).toEqual({ gameRef: GAME_REF, resolved: 0, skipped: 3, note: "batch too large" });
    expect(seen.getMarkets).toHaveLength(0);
    expect(seen.writes).toHaveLength(0);
  });

  test("writeReport gagal di receiver: handler throw, bukan melapor sukses", () => {
    const { runtime } = setup(baseConfig);
    const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR);
    const inner = evm.writeReport!;
    evm.writeReport = (req) => ({
      ...(inner(req) as object),
      receiverContractExecutionStatus: EVM_PB.ReceiverContractExecutionStatus.REVERTED,
    }) as never;

    expect(() => onResolutionRequested(runtime, log([5n]))).toThrow(/receiver reverted/);
  });
});

describe("initWorkflow", () => {
  test("satu handler: log trigger ResolutionRequested di LiveMarket, confidence finalized", () => {
    const [h] = initWorkflow(baseConfig);
    const cfg = (h!.trigger as unknown as { config: EVM_PB.FilterLogTriggerRequest }).config;
    expect(bytesToHex(cfg.addresses[0]!)).toBe(LIVE_MARKET);
    expect(bytesToHex(cfg.topics[0]!.values[0]!)).toBe(TOPIC0);
    expect(cfg.confidence).toBe(EVM_PB.ConfidenceLevel.FINALIZED);
  });
});
