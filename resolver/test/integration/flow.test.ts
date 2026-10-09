// Uji integrasi lokal (RESOLVER_SERVICE.md bagian 5): anvil + LiveMarket + MockForwarder + resolver (src/index.ts
// sebagai proses anak) dengan sumber replay dari fixture. CRE_MODE=off; report palsu dari MockForwarder
// menggantikan CRE. Jalankan: `bun run test:integration` (butuh anvil dan `forge build` di ../../smart-contract).
import {
  GAS_LIMITS, OUTCOME_CODE, SOT, encodeReport, gameKeyOf, liveMarketAbi, mockUsdcAbi, parseLichessJson, resolve,
  type MarketSpec, type SseEvents,
} from "@movemarket/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { FIXTURES } from "../helpers.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const OUT = `${ROOT}smart-contract/out`;
const ARTIFACTS = { MockUSDC: `${OUT}/MockUSDC.sol/MockUSDC.json`, LiveMarket: `${OUT}/LiveMarket.sol/LiveMarket.json`, MockForwarder: `${OUT}/MockForwarder.sol/MockForwarder.json` };
const FIXTURE = new URL("game-export.finished-mate.json", FIXTURES);
const GAME_ID = "e9SJcXpJ";
const GAME_REF = `lichess:game:${GAME_ID}`;

const missing = [
  !Bun.which("anvil") && "anvil (foundryup)",
  ...Object.values(ARTIFACTS).filter((p) => !existsSync(p)).map((p) => `${p} (forge build di smart-contract)`),
].filter(Boolean);
const enabled = process.env.MM_INTEGRATION === "1";
if (!enabled) console.warn("[integration] dilewati: jalankan `bun run test:integration`");
else if (missing.length) console.warn(`[integration] dilewati, prasyarat tidak ada: ${missing.join(", ")}`);

// Kunci default anvil (mnemonic publik "test test ... junk"), hanya untuk chain lokal.
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  resolver: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  alice: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  bob: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;
const ADMIN_TOKEN = "integration-admin";
const PLY_INTERVAL_SEC = 2;

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  void s.stop(true);
  return port;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    await sleep(100);
  }
  throw new Error(`timeout menunggu ${what}`);
}

/** Potongan teks dari stream byte. */
async function* text(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) yield dec.decode(chunk, { stream: true });
}

/** Baris stdout proses anak (log JSON resolver). */
function collect(stream: ReadableStream<Uint8Array>, sink: string[]) {
  void (async () => {
    let buf = "";
    for await (const chunk of text(stream)) {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop()!;
      sink.push(...parts.filter(Boolean));
    }
  })();
}
const logged = (lines: string[], event: string) =>
  lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((o): o is Record<string, unknown> => o?.event === event);

type Sse = { [E in keyof SseEvents]: { event: E; data: SseEvents[E] } }[keyof SseEvents];

describe.skipIf(!enabled || missing.length > 0)("integrasi anvil: replay -> pasar -> bet -> kunci -> request -> report -> claim", () => {
  let anvil: ReturnType<typeof Bun.spawn>;
  let resolver: ReturnType<typeof Bun.spawn>;
  let miner: ReturnType<typeof setInterval>;
  const sseAbort = new AbortController();
  const sse: Sse[] = [];
  /** Saat tiap market_created tiba: timestamp blok latest (waktu chain) dan nomor blok finalized, per id pasar. */
  const createdAtChain = new Map<string, Promise<{ time: bigint; finalized: bigint }>>();
  const out: string[] = [];
  let pub: PublicClient;
  let rpc: string;
  let api: string;
  let liveMarket: Address;
  let usdc: Address;
  let forwarder: Address;
  const gas: Record<string, number> = {};
  const t0 = Date.now();

  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: monadTestnet, transport: http(rpc) });
  const artifact = async (name: keyof typeof ARTIFACTS) => {
    const j = await Bun.file(ARTIFACTS[name]).json() as { abi: Abi; bytecode: { object: Hex } };
    return { abi: j.abi, bytecode: j.bytecode.object };
  };
  async function deploy(name: keyof typeof ARTIFACTS, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = await artifact(name);
    const hash = await wallet(KEYS.deployer).deployContract({ abi, bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }
  async function send(key: Hex, address: Address, abi: Abi, functionName: string, args: unknown[], gasLimit?: number) {
    const hash = await wallet(key).writeContract({ address, abi, functionName, args, ...(gasLimit ? { gas: BigInt(gasLimit) } : {}) });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} revert ${hash}`);
    return r;
  }
  const lockedIds = async () =>
    (await pub.getContractEvents({ address: liveMarket, abi: liveMarketAbi, eventName: "MarketLocked", fromBlock: 0n })).map((e) => e.args.id);
  const requests = () => pub.getContractEvents({ address: liveMarket, abi: liveMarketAbi, eventName: "ResolutionRequested", fromBlock: 0n });
  const waitSse = <E extends keyof SseEvents>(event: E, match: (d: SseEvents[E]) => boolean, timeoutMs?: number) =>
    until(`SSE ${event}`, () => sse.find((e): e is Extract<Sse, { event: E }> => e.event === event && match(e.data as SseEvents[E]))?.data, timeoutMs);

  /**
   * Gas resolver dari eth_estimateGas di anvil terhadap LiveMarket terpisah (resolver = deployer) supaya
   * nonce dan event kontrak utama bersih. Batch: perMarket = est(2) - est(1), base = est(1) - perMarket,
   * lalu buffer SOT gas.bufferPct. Angka anvil, bukan Monad (akses dingin Monad lebih mahal).
   */
  async function measureGas() {
    const deployer = privateKeyToAccount(KEYS.deployer).address;
    const scratch = await deploy("LiveMarket", [usdc, forwarder, deployer]);
    const est = (functionName: string, args: unknown[], address = scratch) =>
      pub.estimateContractGas({ address, abi: liveMarketAbi as Abi, functionName, args, account: deployer });
    const now = (await pub.getBlock()).timestamp;
    const params = (n: number) => Array.from({ length: n }, (_, i) => ({
      gameRef: GAME_REF, marketType: 0, side: 0, fromPly: 25 + i * 4, toPly: 28 + i * 4, lockTime: now + 60n, resolveDeadline: now + 3600n,
    }));
    const raw: Record<string, [bigint, bigint]> = {};
    raw.createMarkets = [await est("createMarkets", [params(1)]), await est("createMarkets", [params(2)])];
    await send(KEYS.deployer, scratch, liveMarketAbi as Abi, "createMarkets", [params(2)]);
    raw.lockMarkets = [await est("lockMarkets", [[1n]]), await est("lockMarkets", [[1n, 2n]])];
    const adminVoid = await est("adminVoid", [[1n]]);
    await send(KEYS.deployer, scratch, liveMarketAbi as Abi, "lockMarkets", [[1n, 2n]]);
    raw.requestResolution = [await est("requestResolution", [GAME_REF, [1n]]), await est("requestResolution", [GAME_REF, [1n, 2n]])];
    const mint = await pub.estimateContractGas({ address: usdc, abi: mockUsdcAbi, functionName: "mint", args: [deployer, 1n], account: deployer });

    const buf = (g: bigint) => Math.ceil(Number(g) * (1 + SOT.gas.bufferPct / 100));
    for (const [fn, [one, two]] of Object.entries(raw)) {
      gas[`${fn}Base`] = buf(one - (two - one));
      gas[`${fn}PerMarket`] = buf(two - one);
    }
    gas.mint = buf(mint);
    gas.adminVoid = buf(adminVoid);
    console.log("[integration] gas anvil (+10%):", JSON.stringify(gas));
  }

  beforeAll(async () => {
    const anvilPort = freePort();
    rpc = `http://127.0.0.1:${anvilPort}`;
    // --chain-id 10143: resolver memakai monadTestnet dari viem/chains (wallet menolak chain id lain).
    // --slots-in-an-epoch 1: tag "finalized" = latest - 2, setara finality Monad 2 blok.
    anvil = Bun.spawn(["anvil", "--port", String(anvilPort), "--chain-id", String(SOT.network.chainId), "--slots-in-an-epoch", "1", "--silent"], { stdout: "ignore", stderr: "inherit" });
    pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) }) as PublicClient;
    await until("anvil", () => pub.getChainId().then(() => true, () => undefined), 15_000);

    const resolverAddr = privateKeyToAccount(KEYS.resolver).address;
    const deployer = privateKeyToAccount(KEYS.deployer).address;
    forwarder = await deploy("MockForwarder", []);
    usdc = await deploy("MockUSDC", []);
    const deployBlock = await pub.getBlockNumber();
    liveMarket = await deploy("LiveMarket", [usdc, forwarder, resolverAddr]);
    await send(KEYS.deployer, usdc, mockUsdcAbi, "setMinter", [resolverAddr, true]);
    await send(KEYS.deployer, usdc, mockUsdcAbi, "setMinter", [deployer, true]);
    await measureGas();

    for (const key of [KEYS.alice, KEYS.bob]) {
      const addr = privateKeyToAccount(key).address;
      await send(KEYS.deployer, usdc, mockUsdcAbi, "mint", [addr, 50_000_000n]);
      await send(key, usdc, mockUsdcAbi, "approve", [liveMarket, 2n ** 255n], GAS_LIMITS.approve);
    }

    // Blok kosong berkala supaya tag finalized maju (blok Monad ~400 ms); transaksi tetap automine.
    miner = setInterval(() => void pub.request({ method: "evm_mine" } as never).catch(() => {}), SOT.network.blockTimeMs);

    const port = freePort();
    api = `http://127.0.0.1:${port}`;
    // Env dibangun dari nol (tanpa process.env, tanpa .env) supaya secret lokal tidak bocor ke proses anak.
    resolver = Bun.spawn(["bun", "--no-env-file", "--preload", `${import.meta.dir}/preload.ts`, `${import.meta.dir}/../../src/index.ts`], {
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        // Tanpa MONAD_TESTNET_WS, seperti deploy Monad: event proposed dari receipt sendiri dan polling blok latest.
        PORT: String(port), MONAD_TESTNET_RPC: rpc,
        LIVE_MARKET_ADDRESS: liveMarket, MOCK_USDC_ADDRESS: usdc, DEPLOY_BLOCK: String(deployBlock),
        CRE_MODE: "off", RESOLVER_PRIVATE_KEY: KEYS.resolver, ADMIN_TOKEN, REPLAY_START_PLY: "20",
        MM_TEST_GAS_LIMITS: JSON.stringify(gas),
      },
      stdout: "pipe", stderr: "inherit",
    });
    collect(resolver.stdout as ReadableStream<Uint8Array>, out);
    await until("resolver listening", () => logged(out, "listening")[0], 15_000);

    // Klien SSE = penonton (D16: tanpa penonton replay berhenti membuat pasar).
    const res = await fetch(`${api}/stream`, { signal: sseAbort.signal });
    void (async () => {
      let buf = "";
      for await (const chunk of text(res.body!)) {
        buf += chunk;
        const frames = buf.split("\n\n");
        buf = frames.pop()!;
        for (const f of frames) {
          const event = /^event: (.+)$/m.exec(f)?.[1];
          const data = /^data: (.+)$/m.exec(f)?.[1];
          if (!event || !data) continue;
          const e = { event, data: JSON.parse(data) } as Sse;
          if (e.event === "market_created") {
            const at = Promise.all([pub.getBlock({ blockTag: "latest" }), pub.getBlock({ blockTag: "finalized" })])
              .then(([l, f]) => ({ time: l.timestamp, finalized: f.number }));
            for (const m of e.data.markets) createdAtChain.set(m.id, at);
          }
          sse.push(e);
        }
      }
    })().catch(() => {});
    await until("viewer", () => fetch(`${api}/health`).then((r) => r.ok || undefined), 5_000);
  }, 60_000);

  afterAll(() => {
    clearInterval(miner);
    sseAbort.abort();
    resolver?.kill();
    anvil?.kill();
    console.log(`[integration] selesai dalam ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  });

  test("pasar ber-stake selesai lewat report palsu dan pemenang claim; pasar tanpa stake tidak di-request", async () => {
    const replay = await fetch(`${api}/admin/replay`, {
      method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ gameId: GAME_ID, plyIntervalSec: PLY_INTERVAL_SEC }),
    });
    expect(await replay.json()).toEqual({ gameRef: GAME_REF });

    // Ply 20 (rapid, PLY_GAP 4): pasar ply 25..28 (skak, makan) dan 25..32 (rokade putih, hitam).
    // Satu SSE market_created per event MarketCreated.
    const created = await until("4 pasar fromPly 25", () => {
      const ms = sse.flatMap((e) => (e.event === "market_created" ? e.data.markets : [])).filter((m) => m.fromPly === 25);
      return ms.length >= 4 ? ms : undefined;
    });
    expect(created.map((m) => [m.marketType, m.side, m.fromPly, m.toPly])).toEqual([
      [0, 0, 25, 28], [1, 0, 25, 28], [2, 1, 25, 32], [2, 2, 25, 32],
    ]);
    const capture = BigInt(created[1]!.id);
    const check = BigInt(created[0]!.id);

    // market_created tiba (tanpa WebSocket) sebelum lockTime pasar menurut waktu chain, jadi masih bisa stake.
    // Juga sebelum blok MarketCreated finalized: bukan dari jalur getLogs finalized (dulu 40-50 detik di Monad).
    const createdBlock = new Map((await pub.getContractEvents({ address: liveMarket, abi: liveMarketAbi, eventName: "MarketCreated", fromBlock: 0n }))
      .map((e) => [String(e.args.id), e.blockNumber]));
    for (const m of created) {
      const at = await createdAtChain.get(m.id)!;
      expect(at.time).toBeLessThan(BigInt(m.lockTime));
      expect(at.finalized).toBeLessThan(createdBlock.get(m.id)!);
    }
    expect(logged(out, "watcher_polling")).toHaveLength(1);

    // Alice 10 tUSDC YES, Bob 5 tUSDC NO di pasar makan, sebelum kunci ply 24.
    await send(KEYS.alice, liveMarket, liveMarketAbi as Abi, "bet", [capture, true, 10_000_000n], GAS_LIMITS.bet);
    await send(KEYS.bob, liveMarket, liveMarketAbi as Abi, "bet", [capture, false, 5_000_000n], GAS_LIMITS.bet);
    await waitSse("pool", (d) => d.marketId === String(capture) && d.poolYes === "10000000" && d.poolNo === "5000000");
    // Receipt, polling, dan jalur finalized melihat MarketCreated yang sama: SSE market_created tetap sekali per id.
    const createdIds = sse.flatMap((e) => (e.event === "market_created" ? e.data.markets.map((m) => m.id) : []));
    expect(new Set(createdIds).size).toBe(createdIds.length);

    // Kunci ply (D11) di ply 24 = fromPly - LOCK_LEAD_PLIES.
    await waitSse("market_locked", (d) => d.marketIds.includes(String(capture)));
    expect(await lockedIds()).toContain(capture);

    // Ply 25 Qxf3: makan -> YES sementara.
    await waitSse("provisional", (d) => d.marketId === String(capture) && d.outcome === "YES");

    // Requester (D17 prasyarat export dari fixture, D18 hanya ber-stake) mengirim requestResolution.
    const [req] = await until("ResolutionRequested", async () => {
      const evs = await requests();
      return evs.length ? evs : undefined;
    });
    expect(req!.args.gameRef).toBe(GAME_REF);
    expect(req!.args.ids).toEqual([capture]);

    // Report palsu: yang akan dilakukan CRE, resolve() atas export resmi (fixture) untuk id di event.
    const snap = parseLichessJson(await Bun.file(FIXTURE).json());
    const specs = await pub.readContract({ address: liveMarket, abi: liveMarketAbi, functionName: "getMarkets", args: [req!.args.ids!] });
    const outcomes = specs.map((m) => resolve(snap, m as MarketSpec));
    expect(outcomes).toEqual(["YES"]);
    const report = encodeReport({ gameKey: gameKeyOf(GAME_REF), ids: req!.args.ids!, outcomes: outcomes.map((o) => OUTCOME_CODE[o as keyof typeof OUTCOME_CODE]) });
    const fwdAbi = (await artifact("MockForwarder")).abi;
    const fwd = await send(KEYS.deployer, forwarder, fwdAbi, "forward", [liveMarket, "0x", report]);

    // Watcher melihat MarketResolved setelah finalized -> SSE finalized.
    const fin = await waitSse("finalized", (d) => d.marketId === String(capture));
    expect(fin).toEqual({ gameRef: GAME_REF, marketId: String(capture), outcome: "YES", voidReason: null, txHash: fwd.transactionHash });

    // Payout = 10 * (15 - 2% fee) / 10 = 14,7 tUSDC.
    const alice = privateKeyToAccount(KEYS.alice).address;
    const before = await pub.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [alice] });
    await send(KEYS.alice, liveMarket, liveMarketAbi as Abi, "claim", [capture], GAS_LIMITS.claim);
    const after = await pub.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [alice] });
    expect(after - before).toBe(14_700_000n);

    // Pasar skak 25..28 tanpa stake: NO sementara di ply 28, lalu dilewati requester (D18).
    await waitSse("provisional", (d) => d.marketId === String(check) && d.outcome === "NO");
    await until("skip_no_stakes", () => logged(out, "skip_no_stakes").find((l) => l.id === String(check)), (SOT.resolver.REQUEST_FLUSH_SEC + 3) * 1000);
    expect((await requests()).flatMap((e) => e.args.ids ?? [])).not.toContain(check);
    const m = await pub.readContract({ address: liveMarket, abi: liveMarketAbi, functionName: "getMarket", args: [check] });
    expect(m.resolutionRequested).toBe(false);

    // Tidak ada akses jaringan selain anvil, dan tidak ada transaksi resolver yang gagal.
    expect(logged(out, "blocked_network")).toEqual([]);
    for (const ev of ["lock_failed", "create_failed", "request_failed", "ply_failed", "watcher_error"]) expect(logged(out, ev)).toEqual([]);
  }, 90_000);
});
