// Bootstrap resolver service (RESOLVER_SERVICE.md). Urutan per ply: registry.apply -> SSE ply -> engine.onPly.
// Tanpa alamat kontrak atau private key, service tetap jalan dalam mode terbatas (HTTP, SSE, ingest, replay)
// dan setiap transaksi gagal dengan error yang jelas.
import { GAS_LIMITS, SOT, liveMarketAbi, type FinalOutcome } from "@movemarket/shared";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { resolve as resolvePath } from "node:path";
import type { Address, Hex } from "viem";
import { createApp } from "./app.ts";
import { contractWriter, createChainClients } from "./chain/clients.ts";
import { createTxQueue } from "./chain/txQueue.ts";
import { createChainWatcher } from "./chain/watcher.ts";
import { loadConfig, secret, type Config } from "./config.ts";
import { log } from "./log.ts";
import type { GameState, Stop, TxQueue } from "./contracts.ts";
import { createCreRunner } from "./cre/runner.ts";
import { createFaucet } from "./faucet/faucet.ts";
import { createGamePipeline } from "./games/pipeline.ts";
import { createGameRegistry } from "./games/registry.ts";
import { createBroadcastFeed, fetchRoundInfo } from "./lichess/broadcast.ts";
import { fetchGameJson, fetchSnapshot } from "./lichess/exportGame.ts";
import { STATUS_OPEN, isMismatch } from "./markets/codes.ts";
import { createMarketEngine } from "./markets/engine.ts";
import { createRequester } from "./markets/requester.ts";
import { MemoryMarketStore } from "./markets/store.ts";
import { createReplayer } from "./replay/replayer.ts";
import { toMarketDto } from "./routes/public.ts";
import { createSseHub } from "./sse/hub.ts";


let cfg: Config;
let chain: ReturnType<typeof createChainClients>;
try {
  cfg = loadConfig();
  chain = createChainClients(cfg);
} catch (err) {
  log("config_error", { err: String((err as Error).message) });
  process.exit(1);
}

const { publicClient, wsClient, resolverWallet, faucetWallet } = chain;
const chainReady = cfg.missing.length === 0;
const limited = [...cfg.missing, ...(resolverWallet ? [] : ["RESOLVER_PRIVATE_KEY"]), ...(faucetWallet ? [] : ["FAUCET_PRIVATE_KEY"])];
if (limited.length) log("limited_mode", { missing: limited });
if (!secret("ADMIN_TOKEN")) log("admin_disabled", { reason: "ADMIN_TOKEN kosong" });

// ----------------------------------------------------------------------- waktu chain
let chainOffsetSec = 0;
const nowSec = () => Math.floor(Date.now() / 1000 + chainOffsetSec);
async function refreshChain() {
  try {
    const b = await publicClient.getBlock({ blockTag: "latest" });
    chainOffsetSec = Number(b.timestamp) - Date.now() / 1000;
    if (resolverWallet) {
      const bal = await publicClient.getBalance({ address: resolverWallet.account.address });
      if (bal < BigInt(SOT.faucet.minResolverMonWei)) log("resolver_low", { balance: bal }); // SOT D19
    }
  } catch (err) {
    log("chain_unreachable", { err: String(err) });
  }
}
void refreshChain();
setInterval(refreshChain, SOT.frontend.chainTimeRefreshSec * 1000);

// ----------------------------------------------------------------------- modul inti
const sse = createSseHub();
const registry = createGameRegistry();
const store = new MemoryMarketStore((id, user) =>
  publicClient.readContract({ address: cfg.liveMarket, abi: liveMarketAbi, functionName: "claimable", args: [id, user] }));

const writer = chainReady && resolverWallet
  ? contractWriter(resolverWallet, publicClient, { liveMarket: cfg.liveMarket, mockUsdc: cfg.mockUsdc })
  : undefined;
const tx: TxQueue = writer
  ? createTxQueue({ write: writer.write, onRetry: (err) => { log("tx_retry", { err: String(err) }); writer.resetNonce(); } })
  : { send: async (t) => { throw new Error(`txQueue tidak aktif (mode terbatas: ${limited.join(", ")}), ${t.kind} tidak dikirim`); } };

const requester = createRequester({
  tx,
  market: (id) => store.get(id),
  fetchExport: (gameRef) => fetchSnapshot(gameRef),
  openIds: async (ids) => {
    const views = await publicClient.readContract({ address: cfg.liveMarket, abi: liveMarketAbi, functionName: "getMarkets", args: [ids] });
    return views.filter((v) => v.status === STATUS_OPEN).map((v) => v.id);
  },
  nowSec,
  log,
  maxBatch: cfg.requestMaxBatch,
});
setInterval(() => requester.flush().catch((err) => log("flush_failed", { err: String(err) })), SOT.resolver.REQUEST_FLUSH_SEC * 1000);

const engine = createMarketEngine({ tx, sse, requester, store, log });

// ----------------------------------------------------------------------- alur per ply
const pipeline = createGamePipeline({ registry, engine, sse, nowSec, log });
const onUpdate = pipeline.onUpdate;

// ----------------------------------------------------------------------- broadcast dan replay
const rounds = new Map<string, Stop>();

async function trackRound(roundId: string): Promise<string[]> {
  const info = await fetchRoundInfo(roundId);
  if (!(SOT.speed.supported as string[]).includes(info.speed)) log("speed_unsupported", { roundId, speed: info.speed });
  const refs = info.chapterIds.map((id) => `lichess:study:${roundId}:${id}`);
  for (const ref of refs) pipeline.track(ref);
  if (!rounds.has(roundId)) {
    rounds.set(roundId, createBroadcastFeed({ roundId, speed: info.speed, log }).start(onUpdate));
    log("track", { roundId, games: refs.length, speed: info.speed });
  }
  return refs;
}

const hasPendingStakes = (gameRef: string) =>
  store.byGame(gameRef).some((m) => m.final === null && m.poolYes + m.poolNo > 0n);

const replayer = createReplayer({
  fetchGame: (id) => fetchGameJson(id),
  onUpdate,
  newRun: pipeline.newRun,
  sse,
  engine,
  hasPendingStakes,
  liveGames: () => registry.all().filter((g) => !g.isReplay && !g.ended && !pipeline.isUntracked(g.gameRef)).length,
  pool: cfg.replayPool,
  ...cfg.replay,
  log,
});
setInterval(() => replayer.tick().catch((err) => log("replay_tick_failed", { err: String(err) })), 1000);

// ----------------------------------------------------------------------- chain: watcher, CRE, pemulihan
const cre = cfg.creMode === "simulate"
  ? createCreRunner({ projectDir: resolvePath(cfg.creProjectDir), target: cfg.creTarget })
  : undefined;

/** Provisional dari export resmi untuk partai yang tidak (lagi) dilacak, lalu masuk requester (2.11). */
async function recoverGame(gameRef: string) {
  try {
    const snap = await fetchSnapshot(gameRef);
    const study = gameRef.startsWith("lichess:study:");
    if (study && !snap.ended) await trackRound(gameRef.split(":")[2]!);
    const state: GameState = {
      gameRef, source: study ? "broadcast" : "replay", speed: "unknown", white: { name: "?" }, black: { name: "?" },
      sans: snap.sans, ended: snap.ended, isReplay: !study, fen: "", castled: { white: false, black: false }, updatedAt: Date.now(),
    };
    await engine.onCorrection(state, nowSec());
  } catch (err) {
    log("recover_failed", { gameRef, err: String(err) });
  }
}

async function startChain() {
  let startHead = 0n;
  try { startHead = await publicClient.getBlockNumber(); } catch (err) { log("chain_unreachable", { err: String(err) }); }
  const watcher = createChainWatcher({
    client: publicClient, wsClient, address: cfg.liveMarket, fromBlock: cfg.deployBlock,
    onError: (err) => log("watcher_error", { err: String(err) }),
  });
  watcher.subscribe((ev, fin) => {
    store.apply(ev);
    const live = ev.blockNumber >= startHead; // event lama (pemulihan) tidak dikirim ke SSE dan tidak menjalankan CRE
    if (fin === "proposed") {
      if (!live) return;
      if (ev.name === "MarketCreated") {
        const m = store.get(ev.args.id);
        if (m) sse.publish("market_created", { gameRef: m.gameRef, markets: [toMarketDto(m)] });
      } else if (ev.name === "BetPlaced") {
        const m = store.get(ev.args.id);
        if (m) sse.publish("pool", { gameRef: m.gameRef, marketId: String(ev.args.id), poolYes: String(ev.args.poolYes), poolNo: String(ev.args.poolNo) });
      }
      return;
    }
    if (ev.name === "MarketResolved" || ev.name === "MarketVoided") {
      const id = ev.args.id;
      requester.settled(id);
      const m = store.get(id);
      if (!m || !m.final || !live) return;
      const voidReason = ev.name === "MarketVoided" ? m.voidReason : null;
      if (isMismatch(m)) log("mismatch", { id, gameRef: m.gameRef, final: m.final, provisional: m.provisional, voidReason });
      sse.publish("finalized", { gameRef: m.gameRef, marketId: String(id), outcome: m.final as FinalOutcome, voidReason, txHash: ev.txHash });
    } else if (ev.name === "ResolutionRequested" && live && cre) {
      const txHash = ev.txHash;
      cre.run(txHash).then(
        (r) => log("cre_done", { txHash, ...r }),
        (err) => log("cre_run_failed", { txHash, err: String(err) }),
      );
    }
  });

  // Setelah backfill sejak DEPLOY_BLOCK mencapai head saat start: pulihkan partai dengan pasar belum final.
  const wait = setInterval(() => {
    if (watcher.cursor() < startHead) return;
    clearInterval(wait);
    const refs = new Set(store.all().filter((m) => m.final === null).map((m) => m.gameRef));
    log("recovered", { markets: store.all().length, openGames: refs.size });
    for (const ref of refs) if (!registry.get(ref)) void recoverGame(ref);
  }, 1000);
}
if (chainReady) void startChain();

// ----------------------------------------------------------------------- faucet
const faucet = chainReady && resolverWallet && faucetWallet
  ? createFaucet({
    ...cfg.faucet,
    mintUsdc: async (to, amount) => (await tx.send({ kind: "mint", to, amount })).transactionHash,
    sendMon: async (to, value) => {
      const hash = await faucetWallet.sendTransaction({ to, value, gas: BigInt(GAS_LIMITS.nativeTransfer) });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transfer MON revert: ${hash}`);
      return hash;
    },
    faucetBalance: () => publicClient.getBalance({ address: faucetWallet.account.address }),
    balanceOf: (address) => publicClient.getBalance({ address }),
    log,
  })
  : undefined;

// ----------------------------------------------------------------------- HTTP
function clientIp(c: Context): string {
  if (cfg.trustProxy) {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  try { return getConnInfo(c).remote.address ?? "unknown"; } catch { return "unknown"; }
}

const app = createApp({
  registry: { all: pipeline.tracked, get: registry.get }, store, sse, faucet, nowSec, creMode: cfg.creMode, clientIp,
  corsOrigin: cfg.corsOrigin,
  adminToken: secret("ADMIN_TOKEN"),
  admin: {
    track: async (b) => {
      if (b.source !== "broadcast") throw new Error("sumber tv belum didukung (Could)");
      return trackRound(b.roundId);
    },
    untrack: (gameRef) => {
      pipeline.untrack(gameRef);
      if (replayer.active() === gameRef) replayer.stop();
      log("untrack", { gameRef });
    },
    replay: (gameId, plyIntervalSec) => replayer.start(gameId, plyIntervalSec),
    void: async (ids): Promise<Hex> => (await tx.send({ kind: "adminVoid", ids })).transactionHash,
    state: () => ({
      config: cfg, limited, chainOffsetSec, viewers: sse.viewers(), replay: replayer.active(),
      rounds: [...rounds.keys()], untracked: pipeline.untracked(),
      games: registry.all().map((g) => ({ gameRef: g.gameRef, ply: g.sans.length, ended: g.ended, speed: g.speed })),
      markets: store.all(),
      creFailed: requester.failed(), // keputusan operator: POST /admin/void
    }),
  },
});

const server = Bun.serve({ port: cfg.port, fetch: app.fetch, idleTimeout: SOT.resolver.SSE_PING_SEC * 2 });
log("listening", { port: server.port, chainReady, creMode: cfg.creMode, resolver: resolverWallet?.account.address as Address | undefined });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const stop of rounds.values()) stop();
    replayer.stop();
    void server.stop();
    process.exit(0);
  });
}
