import { expect, test } from "bun:test";
import { SOT } from "@movemarket/shared";
import { encodeAbiParameters, hexToBytes, parseAbiParameters } from "viem";
import { type MarketView, batchProblem, configSchema, openViews, parsePayload, payloadFromBody, decodeResolutionRequested, RESOLUTION_REQUESTED_TOPIC } from "./logic";

// Nilai independen dari sot/test-vectors.json (gameKey) dan docs/CRE_WORKFLOW.md bagian 3 (topic0).
const GAME_REF = "lichess:game:e9SJcXpJ";
const GAME_KEY = "0xf7d3f3f6514378c5b767be2d036c18b0aa5bba84ae50a0bfdaad7591841aef1f";
const TOPIC0 = "0xee0a59e1d791944ec08c9b8362a29a47dea1e8b5c268d11762fbbd929632a586";

const logOf = (gameKey: `0x${string}`, gameRef: string, ids: bigint[]) => ({
  topics: [hexToBytes(TOPIC0), hexToBytes(gameKey)],
  data: hexToBytes(encodeAbiParameters(parseAbiParameters("string, uint256[]"), [gameRef, ids])),
});

test("topic0 ResolutionRequested sama dengan dokumen", () => {
  expect(RESOLUTION_REQUESTED_TOPIC).toBe(TOPIC0);
});

test("decode log ResolutionRequested menjadi gameKey, gameRef, ids bigint", () => {
  expect(decodeResolutionRequested(logOf(GAME_KEY, GAME_REF, [3n, 10n]))).toEqual({
    gameKey: GAME_KEY,
    gameRef: GAME_REF,
    ids: [3n, 10n],
  });
});

test("batchProblem: gameKey harus keccak gameRef, 1 sampai max id", () => {
  const ok = { gameKey: GAME_KEY, gameRef: GAME_REF, ids: [1n] } as const;
  expect(batchProblem(ok, 8)).toBeNull();
  expect(batchProblem({ ...ok, gameRef: "lichess:game:AAAAAAAA" }, 8)).toBe("gameKey mismatch");
  expect(batchProblem({ ...ok, ids: [] }, 8)).toBe("empty batch");
  expect(batchProblem({ ...ok, ids: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] }, 8)).toBeNull();
  expect(batchProblem({ ...ok, ids: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n] }, 8)).toBe("batch too large");
});

const view = (id: bigint, over: Partial<MarketView> = {}): MarketView => ({
  id, gameKey: GAME_KEY, marketType: 0, side: 0, fromPly: 10, toPly: 12, lockTime: 0n, status: 0, ...over,
});

test("openViews membuang pasar yang bukan OPEN atau gameKey-nya beda", () => {
  const views = [view(1n), view(2n, { status: 1 }), view(3n, { gameKey: `0x${"00".repeat(32)}` }), view(4n, { status: 2 }), view(5n)];
  expect(openViews(views, GAME_KEY).map((v) => v.id)).toEqual([1n, 5n]);
});

// Fixture dibaca dari tempatnya (CLAUDE.md aturan 10), tidak disalin.
const FIXTURES = new URL("../../../source/sot/fixtures/lichess/", import.meta.url);
const fixtures = Object.fromEntries(
  await Promise.all(
    ["game-export.finished-mate.json", "game-export.ongoing-rapid.json", "study-chapter.cbVdruwJ.fGXnnaOp.pgn"].map(
      async (f) => [f, await Bun.file(new URL(f, FIXTURES)).text()] as const,
    ),
  ),
);
const fixture = (file: string) => fixtures[file]!;

test("payloadFromBody (json): skak mat di ply 59 YES, ply setelah partai selesai VOID", () => {
  // game-export.finished-mate.json: 59 ply, selesai, ply 59 = Qxb7#.
  const views = [view(9n, { marketType: 1, fromPly: 60, toPly: 62 }), view(5n, { fromPly: 59, toPly: 59 })];
  expect(payloadFromBody(fixture("game-export.finished-mate.json"), "json", views)).toBe("5:1,9:3");
});

test("payloadFromBody (json): pasar yang belum pasti (PENDING) tidak ikut", () => {
  // game-export.ongoing-rapid.json: 44 ply, belum selesai.
  expect(payloadFromBody(fixture("game-export.ongoing-rapid.json"), "json", [view(1n, { fromPly: 45, toPly: 46 })])).toBe("");
});

test("payloadFromBody (pgn): ply 41 Qe3 bukan skak, rentang lengkap NO", () => {
  expect(payloadFromBody(fixture("study-chapter.cbVdruwJ.fGXnnaOp.pgn"), "pgn", [view(2n, { fromPly: 41, toPly: 41 })])).toBe("2:2");
});

test("parsePayload: payload konsensus jadi ids dan outcomes report", () => {
  expect(parsePayload("3:2,10:3,12:1")).toEqual({ ids: [3n, 10n, 12n], outcomes: [2, 3, 1] });
  expect(parsePayload("")).toEqual({ ids: [], outcomes: [] });
  expect(() => parsePayload("3:0")).toThrow();
  expect(() => parsePayload("x:1")).toThrow();
});

const validConfig = {
  mode: "onchain",
  chainSelectorName: "monad-testnet",
  liveMarketAddress: "0x1111111111111111111111111111111111111111",
  gasLimit: "1000000",
  maxMarketsPerReport: 8,
  lichessBaseUrl: "https://lichess.org",
};

test("configSchema menerima config valid dan menolak mode, alamat, atau gasLimit yang salah", () => {
  expect(configSchema.parse(validConfig)).toEqual(validConfig as never);
  expect(configSchema.parse({ ...validConfig, mode: "local-simulation" }).mode).toBe("local-simulation");
  for (const bad of [
    { mode: "dry-run" },
    { chainSelectorName: "ethereum-mainnet" },
    { liveMarketAddress: "0x0000000000000000000000000000000000000000" },
    { liveMarketAddress: "0x123" },
    { gasLimit: "1e6" },
    { maxMarketsPerReport: 0 },
    { lichessBaseUrl: "lichess.org" },
  ]) expect(configSchema.safeParse({ ...validConfig, ...bad }).success).toBe(false);
});

test("config.<target>.json valid dan memakai nilai SOT (alamat diisi setelah deploy)", async () => {
  for (const [target, mode] of [["staging", "onchain"], ["production", "onchain"], ["local-simulation", "local-simulation"]]) {
    const raw = await Bun.file(new URL(`config.${target}.json`, import.meta.url)).json();
    // Setelah script deploy mengisi sot/constants.json, config wajib ikut diperbarui.
    if (SOT.addresses.liveMarket) expect(raw.liveMarketAddress).toBe(SOT.addresses.liveMarket);
    const cfg = configSchema.parse({ ...raw, liveMarketAddress: SOT.addresses.liveMarket ?? validConfig.liveMarketAddress });
    expect([target, cfg.mode]).toEqual([target, mode]);
    expect(cfg.gasLimit).toBe(SOT.cre.gasLimit);
    expect(cfg.maxMarketsPerReport).toBe(SOT.cre.maxMarketsPerReport);
    expect(cfg.chainSelectorName).toBe(SOT.network.creChainSelectorName as never);
  }
});
