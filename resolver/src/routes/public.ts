// Route publik (RESOLVER_SERVICE.md 3.1, tipe di ResolverRoutes). Id dan nominal dikirim sebagai string desimal.
import {
  COPY, SOT, describeMarket, type ApiError, type CreMode, type GameDetail, type GameSummary, type MarketDto, type ResolverRoutes,
} from "@movemarket/shared";
import { Hono, type Context } from "hono";
import { isAddress, type Address } from "viem";
import { log } from "../log.ts";
import { FaucetError, type Faucet, type GameRegistry, type GameState, type MarketStore, type SseHub, type TrackedMarket } from "../contracts.ts";

export interface PublicDeps {
  registry: Pick<GameRegistry, "all" | "get">;
  store: Pick<MarketStore, "positions"> & { all(): TrackedMarket[] };
  sse: Pick<SseHub, "handle">;
  /** MarketEngine.marketsOf: pasar run sekarang (replay ulang tidak menggandakan pertanyaan). */
  marketsOf(gameRef: string): TrackedMarket[];
  /** undefined di mode terbatas (alamat kontrak atau key faucet belum diisi): 503. */
  faucet?: Faucet;
  nowSec(): number;
  creMode: CreMode;
  clientIp(c: Context): string;
}

type Res<R extends keyof ResolverRoutes> = ResolverRoutes[R]["res"];

export const apiError = (c: Context, status: 400 | 401 | 404 | 409 | 429 | 500 | 501 | 502 | 503, error: string, code?: ApiError["code"]) =>
  c.json<ApiError>(code ? { error, code } : { error }, status);

/** SOT planner.openMarketDefinition: lockTime > now. */
const isOpen = (m: TrackedMarket, nowSec: number) => m.lockTime > nowSec;

export function toMarketDto(m: TrackedMarket): MarketDto {
  const spec = { marketType: m.marketType, side: m.side, fromPly: m.fromPly, toPly: m.toPly };
  return {
    id: m.id.toString(), ...spec, lockTime: m.lockTime, resolveDeadline: m.resolveDeadline,
    question: describeMarket(spec, COPY),
    poolYes: m.poolYes.toString(), poolNo: m.poolNo.toString(),
    provisional: m.provisional === "PENDING" ? null : m.provisional,
    final: m.final, voidReason: m.voidReason,
  };
}

function toSummary(g: GameState, markets: TrackedMarket[], nowSec: number): GameSummary {
  return {
    gameRef: g.gameRef, source: g.source, isReplay: g.isReplay, speed: g.speed, white: g.white, black: g.black,
    ply: g.sans.length, fen: g.fen, ended: g.ended, ...(g.result ? { result: g.result } : {}),
    openMarkets: markets.filter((m) => isOpen(m, nowSec)).length,
  };
}

async function addressBody(c: Context): Promise<Address | null> {
  const body = await c.req.json().catch(() => null) as { address?: unknown } | null;
  return typeof body?.address === "string" && isAddress(body.address) ? body.address : null;
}

export function publicRoutes(d: PublicDeps): Hono {
  const app = new Hono();

  const faucetCall = async (c: Context, fn: (f: Faucet, a: Address) => Promise<unknown>) => {
    if (!d.faucet) return apiError(c, 503, "faucet tidak aktif", "FAUCET_FAILED");
    const address = await addressBody(c);
    if (!address) return apiError(c, 400, "alamat tidak valid");
    try {
      return c.json(await fn(d.faucet, address));
    } catch (err) {
      if (err instanceof FaucetError) return apiError(c, err.status, err.message, err.code);
      log("faucet_failed", { err: String(err) });
      return apiError(c, 500, "faucet gagal", "FAUCET_FAILED");
    }
  };

  app.get("/health", (c) => {
    const now = d.nowSec();
    return c.json<Res<"GET /health">>({
      ok: true, chainId: SOT.network.chainId, creMode: d.creMode,
      trackedGames: d.registry.all().length, openMarkets: d.store.all().filter((m) => isOpen(m, now)).length,
    });
  });

  app.get("/games", (c) => {
    const now = d.nowSec();
    return c.json<Res<"GET /games">>({ games: d.registry.all().map((g) => toSummary(g, d.marketsOf(g.gameRef), now)) });
  });

  app.get("/games/:gameRef", (c) => {
    const g = d.registry.get(c.req.param("gameRef"));
    if (!g) return apiError(c, 404, "partai tidak dilacak");
    const markets = d.marketsOf(g.gameRef);
    const game: GameDetail = { ...toSummary(g, markets, d.nowSec()), sans: g.sans };
    return c.json<Res<"GET /games/:gameRef">>({ game, markets: markets.map(toMarketDto) });
  });

  app.get("/positions/:address", async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return apiError(c, 400, "alamat tidak valid");
    return c.json<Res<"GET /positions/:address">>({ positions: await d.store.positions(address) });
  });

  app.post("/faucet", (c) => faucetCall(c, (f, a) => f.onboard(a, d.clientIp(c))));
  app.post("/faucet/gas", (c) => faucetCall(c, (f, a) => f.topUpGas(a, d.clientIp(c))));

  app.get("/stream", (c) => d.sse.handle(c.req.raw));

  return app;
}
