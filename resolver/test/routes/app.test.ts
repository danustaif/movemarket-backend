import { describe, expect, test } from "bun:test";
import type { GameDetail, MarketDto } from "@movemarket/shared";
import { createApp, type AppDeps } from "../../src/app.ts";
import { FaucetError, type GameState, type TrackedMarket } from "../../src/contracts.ts";
import { createSseHub } from "../../src/sse/hub.ts";

const REF = "lichess:game:ymG9hwyh";
const game: GameState = {
  gameRef: REF, source: "replay", speed: "rapid", white: { name: "W", rating: 2400 }, black: { name: "B" },
  sans: ["e4", "e5"], ended: false, isReplay: true, fen: "fen", castled: { white: false, black: false }, updatedAt: 0,
};
const market = (id: bigint, lockTime: number, p: Partial<TrackedMarket> = {}): TrackedMarket => ({
  id, gameRef: REF, marketType: 0, side: 0, fromPly: 33, toPly: 36, lockTime, resolveDeadline: lockTime + 21600,
  poolYes: 12_000_000n, poolNo: 5_000_000n, provisional: "PENDING", requested: false, final: null, voidReason: null, ...p,
});
const A = "0x00000000000000000000000000000000000000aa";
const TX = `0x${"11".repeat(32)}` as const;

function setup(over: Partial<AppDeps> = {}) {
  const calls: string[] = [];
  const markets = [market(123n, 2000), market(124n, 500, { provisional: "YES", final: "VOID", voidReason: 2 })];
  const deps: AppDeps = {
    registry: { all: () => [game], get: (r) => (r === REF ? game : undefined) },
    store: {
      all: () => markets, byGame: (r) => markets.filter((m) => m.gameRef === r),
      positions: async () => [{ marketId: "123", gameRef: REF, stakeYes: "5", stakeNo: "0", status: 0, outcome: 0, resolveDeadline: 1, settled: false, claimable: "0", voidReason: null }],
    },
    sse: createSseHub({ pingSec: 0 }),
    faucet: {
      onboard: async (a, ip) => { calls.push(`onboard:${a}:${ip}`); return { usdcTx: TX, monTx: null }; },
      topUpGas: async () => { throw new FaucetError(429, "GAS_TOPUP_LIMIT"); },
    },
    nowSec: () => 1000,
    creMode: "simulate",
    corsOrigin: "http://localhost:5173",
    adminToken: "s3cret",
    clientIp: () => "7.7.7.7",
    admin: {
      track: async (b) => { calls.push(`track:${JSON.stringify(b)}`); return ["lichess:study:AbCd1234:EfGh5678"]; },
      untrack: (r) => { calls.push(`untrack:${r}`); },
      replay: async (id, s) => { calls.push(`replay:${id}:${s}`); return `lichess:game:${id}`; },
      void: async (ids) => { calls.push(`void:${ids.join(",")}`); return TX; },
      state: () => ({ big: 1n }),
    },
    ...over,
  };
  return { app: createApp(deps), calls };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const ADMIN = { authorization: "Bearer s3cret" };

describe("route publik", () => {
  test("GET /health", async () => {
    const res = await setup().app.request("/health");
    expect(await res.json()).toEqual({ ok: true, chainId: 10143, creMode: "simulate", trackedGames: 1, openMarkets: 1 });
  });

  test("GET /games dan /games/:gameRef: id dan nominal string desimal, openMarkets = lockTime > now", async () => {
    const { app } = setup();
    const list = await (await app.request("/games")).json();
    expect(list.games[0]).toEqual({
      gameRef: REF, source: "replay", isReplay: true, speed: "rapid", white: { name: "W", rating: 2400 }, black: { name: "B" },
      ply: 2, fen: "fen", ended: false, openMarkets: 1,
    });
    const res = await app.request(`/games/${encodeURIComponent(REF)}`);
    const body = (await res.json()) as { game: GameDetail; markets: MarketDto[] };
    expect(body.game.sans).toEqual(["e4", "e5"]);
    expect(body.markets[0]).toEqual({
      id: "123", marketType: 0, side: 0, fromPly: 33, toPly: 36, lockTime: 2000, resolveDeadline: 23600,
      question: "Any check in plies 33 to 36 (moves 17 to 18)?",
      poolYes: "12000000", poolNo: "5000000", provisional: null, final: null, voidReason: null,
    });
    expect(body.markets[1]).toMatchObject({ provisional: "YES", final: "VOID", voidReason: 2 });
    expect((await app.request("/games/lichess%3Agame%3Anope0000")).status).toBe(404);
  });

  test("GET /positions/:address: 400 kalau alamat tidak valid", async () => {
    const { app } = setup();
    expect((await (await app.request(`/positions/${A}`)).json()).positions[0].marketId).toBe("123");
    const bad = await app.request("/positions/0x12");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toHaveProperty("error");
  });

  test("POST /faucet memakai IP dari clientIp; FaucetError jadi ApiError dengan status dan code", async () => {
    const { app, calls } = setup();
    const ok = await app.request("/faucet", post({ address: A }));
    expect(await ok.json()).toEqual({ usdcTx: TX, monTx: null });
    expect(calls).toEqual([`onboard:${A}:7.7.7.7`]);
    const lim = await app.request("/faucet/gas", post({ address: A }));
    expect(lim.status).toBe(429);
    expect(await lim.json()).toEqual({ error: "GAS_TOPUP_LIMIT", code: "GAS_TOPUP_LIMIT" });
    expect((await app.request("/faucet", post({ nope: 1 }))).status).toBe(400);
  });

  test("faucet error tak terduga: 500 FAUCET_FAILED; faucet tidak aktif: 503", async () => {
    const boom = setup({ faucet: { onboard: async () => { throw new Error("rpc down"); }, topUpGas: async () => ({ monTx: TX }) } });
    const res = await boom.app.request("/faucet", post({ address: A }));
    expect([res.status, (await res.json()).code]).toEqual([500, "FAUCET_FAILED"]);
    const off = setup({ faucet: undefined });
    expect((await off.app.request("/faucet", post({ address: A }))).status).toBe(503);
  });

  test("CORS dari CORS_ORIGIN", async () => {
    const res = await setup().app.request("/health", { headers: { origin: "http://localhost:5173" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  test("GET /stream menghasilkan event-stream", async () => {
    const res = await setup().app.request(`/stream?gameRef=${encodeURIComponent(REF)}`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body!.cancel();
  });
});

describe("route admin", () => {
  test("tanpa token atau token salah: 401", async () => {
    const { app, calls } = setup();
    expect((await app.request("/admin/state")).status).toBe(401);
    expect((await app.request("/admin/untrack", post({ gameRef: REF }, { authorization: "Bearer salah" }))).status).toBe(401);
    expect(calls).toEqual([]);
    const noToken = setup({ adminToken: undefined });
    expect((await noToken.app.request("/admin/state", { headers: ADMIN })).status).toBe(401);
  });

  test("track, untrack, replay, void, state", async () => {
    const { app, calls } = setup();
    expect(await (await app.request("/admin/track", post({ source: "broadcast", roundId: "AbCd1234" }, ADMIN))).json())
      .toEqual({ gameRefs: ["lichess:study:AbCd1234:EfGh5678"] });
    expect(await (await app.request("/admin/untrack", post({ gameRef: REF }, ADMIN))).json()).toEqual({ ok: true });
    expect(await (await app.request("/admin/replay", post({ gameId: "ymG9hwyh", plyIntervalSec: 5 }, ADMIN))).json())
      .toEqual({ gameRef: REF });
    expect(await (await app.request("/admin/void", post({ marketIds: ["1", "2"] }, ADMIN))).json()).toEqual({ txHash: TX });
    expect(await (await app.request("/admin/state", { headers: ADMIN })).json()).toEqual({ big: "1" });
    expect(calls).toEqual([
      'track:{"source":"broadcast","roundId":"AbCd1234"}', `untrack:${REF}`, "replay:ymG9hwyh:5", "void:1,2",
    ]);
    expect((await app.request("/admin/void", post({ marketIds: ["x"] }, ADMIN))).status).toBe(400);
  });

  test("error aksi admin: 502 dengan pesan generik, URL RPC tidak bocor; state diredaksi", async () => {
    const rpc = "https://monad-testnet.g.alchemy.com/v2/AbCdSecret123";
    const { app } = setup({
      admin: {
        track: async () => { throw new Error(`HTTP request failed. URL: ${rpc}`); },
        untrack: () => {}, replay: async () => REF, void: async () => TX,
        state: () => ({ config: { rpcUrl: rpc, wsUrl: "wss://rpc.example.io/ws?apikey=k3y" } }),
      },
    });
    const res = await app.request("/admin/track", post({ source: "broadcast", roundId: "AbCd1234" }, ADMIN));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("AbCdSecret123");
    const state = await (await app.request("/admin/state", { headers: ADMIN })).text();
    expect(state).not.toContain("AbCdSecret123");
    expect(state).not.toContain("k3y");
    expect(JSON.parse(state).config.rpcUrl).toBe("https://monad-testnet.g.alchemy.com/***");
  });
});
