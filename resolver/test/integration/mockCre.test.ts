// Uji integrasi CRE_MODE=mock (SOT D23): runner mock + txQueue + contractWriter terhadap anvil, dengan bytecode
// MockKeystoneForwarder ASLI di alamat SOT (MockKeystoneForwarder.runtime.hex = `cast code 0xB9F79d...` Monad Testnet,
// diambil 10 Oktober 2026, typeAndVersion "MockKeystoneForwarder 1.0.0"). Jalankan: `bun run test:integration`.
import { ENUMS, SOT, liveMarketAbi, mockUsdcAbi, parseLichessJson } from "@movemarket/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { contractWriter } from "../../src/chain/clients.ts";
import { createTxQueue } from "../../src/chain/txQueue.ts";
import type { MarketParams } from "../../src/contracts.ts";
import { createMockCreRunner } from "../../src/cre/mockRunner.ts";
import { fixture } from "../helpers.ts";

const OUT = new URL("../../../../smart-contract/out/", import.meta.url).pathname;
const ARTIFACTS = { MockUSDC: `${OUT}MockUSDC.sol/MockUSDC.json`, LiveMarket: `${OUT}LiveMarket.sol/LiveMarket.json` };
const FORWARDER = SOT.addresses.creMockKeystoneForwarder as Address;
const GAME_REF = "lichess:game:e9SJcXpJ"; // fixture game-export.finished-mate.json: 59 ply, Qxb7# di ply 59

const missing = [
  !Bun.which("anvil") && "anvil (foundryup)",
  ...Object.values(ARTIFACTS).filter((p) => !existsSync(p)).map((p) => `${p} (forge build di smart-contract)`),
].filter(Boolean);
const enabled = process.env.MM_INTEGRATION === "1";
if (enabled && missing.length) console.warn(`[integration] mock CRE dilewati, prasyarat tidak ada: ${missing.join(", ")}`);

// Kunci default anvil (mnemonic publik "test test ... junk"), hanya untuk chain lokal.
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  resolver: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  alice: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const satisfies Record<string, Hex>;

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  void s.stop(true);
  return port;
};

describe.skipIf(!enabled || missing.length > 0)("integrasi anvil: CRE_MODE=mock lewat MockKeystoneForwarder asli", () => {
  let anvil: ReturnType<typeof Bun.spawn>;
  let pub: PublicClient;
  let rpc: string;
  let liveMarket: Address;
  let usdc: Address;
  let tx: ReturnType<typeof createTxQueue>;
  let runner: ReturnType<typeof createMockCreRunner>;

  const rpcCall = (method: string, params: unknown[] = []) => pub.request({ method, params } as never);
  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key, { nonceManager }), chain: monadTestnet, transport: http(rpc) });
  async function send(key: Hex, address: Address, abi: Abi, functionName: string, args: unknown[]) {
    const hash = await wallet(key).writeContract({ address, abi, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} revert ${hash}`);
    return r;
  }
  async function deploy(name: keyof typeof ARTIFACTS, args: unknown[]): Promise<Address> {
    const j = await Bun.file(ARTIFACTS[name]).json() as { abi: Abi; bytecode: { object: Hex } };
    const hash = await wallet(KEYS.deployer).deployContract({ abi: j.abi, bytecode: j.bytecode.object, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }
  /** Pasar e9SJcXpJ, lockTime 5 detik lagi; lalu waktu dimajukan dan requestResolution (resolver). */
  async function marketsRequested(params: Omit<MarketParams, "gameRef" | "lockTime" | "resolveDeadline">[], bets: (id: bigint) => Promise<void>) {
    const now = (await pub.getBlock()).timestamp;
    const before = await pub.readContract({ address: liveMarket, abi: liveMarketAbi, functionName: "nextMarketId" });
    await tx.send({ kind: "createMarkets", params: params.map((p) => ({ ...p, gameRef: GAME_REF, lockTime: now + 5n, resolveDeadline: now + 3600n })) });
    const ids = params.map((_, i) => before + BigInt(i));
    await bets(ids[0]!);
    await rpcCall("evm_increaseTime", [10]);
    const req = await tx.send({ kind: "requestResolution", gameRef: GAME_REF, ids });
    for (let i = 0; i < 3; i++) await rpcCall("evm_mine"); // tag finalized = latest - 2 (--slots-in-an-epoch 1)
    return { ids, requestTx: req.transactionHash };
  }
  const status = async (id: bigint) =>
    ENUMS.Status[(await pub.readContract({ address: liveMarket, abi: liveMarketAbi, functionName: "getMarket", args: [id] })).status];

  beforeAll(async () => {
    const port = freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = Bun.spawn(["anvil", "--port", String(port), "--chain-id", String(SOT.network.chainId), "--slots-in-an-epoch", "1", "--silent"], { stdout: "ignore", stderr: "inherit" });
    pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) }) as PublicClient;
    for (let i = 0; i < 150 && !(await pub.getChainId().catch(() => 0)); i++) await Bun.sleep(100);

    const code = (await Bun.file(new URL("MockKeystoneForwarder.runtime.hex", import.meta.url)).text()).trim();
    await rpcCall("anvil_setCode", [FORWARDER, code]);
    const resolver = privateKeyToAccount(KEYS.resolver).address;
    usdc = await deploy("MockUSDC", []);
    liveMarket = await deploy("LiveMarket", [usdc, FORWARDER, resolver]);
    const alice = privateKeyToAccount(KEYS.alice).address;
    await send(KEYS.deployer, usdc, mockUsdcAbi, "setMinter", [privateKeyToAccount(KEYS.deployer).address, true]);
    await send(KEYS.deployer, usdc, mockUsdcAbi, "mint", [alice, 50_000_000n]);
    await send(KEYS.alice, usdc, mockUsdcAbi, "approve", [liveMarket, 2n ** 255n]);

    // Sama dengan wiring index.ts: satu txQueue wallet resolver, forwarder default dari SOT.
    const writer = contractWriter(wallet(KEYS.resolver), pub, { liveMarket, mockUsdc: usdc });
    tx = createTxQueue({ write: writer.write });
    const snapshot = parseLichessJson(JSON.parse(await fixture("game-export.finished-mate.json")));
    runner = createMockCreRunner({
      client: pub, liveMarket, tx, fetchSnapshot: async () => snapshot, nowSec: () => Math.floor(Date.now() / 1000),
    });
  }, 30_000);

  afterAll(() => anvil?.kill());

  test("report mock menyelesaikan pasar ber-stake (YES) dan pasar setelah partai selesai (VOID)", async () => {
    let check = 0n;
    const { ids, requestTx } = await marketsRequested(
      [{ marketType: 0, side: 0, fromPly: 59, toPly: 59 }, { marketType: 1, side: 0, fromPly: 60, toPly: 62 }],
      async (id) => { check = id; await send(KEYS.alice, liveMarket, liveMarketAbi as Abi, "bet", [id, true, 10_000_000n]); },
    );

    const r = await runner.run(requestTx);
    expect(r).toMatchObject({ gameRef: GAME_REF, resolved: 2, skipped: 0, note: "mock-cre" });
    expect(await status(check)).toBe("RESOLVED");
    expect(await status(ids[1]!)).toBe("VOIDED");
    const fwd = await pub.getTransaction({ hash: r.txHash! });
    expect(fwd.to?.toLowerCase()).toBe(FORWARDER.toLowerCase());
    expect(fwd.gas).toBe(BigInt(SOT.cre.gasLimit));

    // Request yang sama lagi: pasar sudah tidak OPEN di blok finalized -> tanpa tx.
    for (let i = 0; i < 3; i++) await rpcCall("evm_mine");
    expect(await runner.run(requestTx)).toEqual({ gameRef: GAME_REF, resolved: 0, skipped: 2, note: "nothing to resolve" });
  }, 30_000);

  test("LiveMarket menolak forwarder (onReport revert): forwarder tidak revert, runner melempar error", async () => {
    const { ids, requestTx } = await marketsRequested([{ marketType: 0, side: 0, fromPly: 59, toPly: 59 }], async () => {});
    await send(KEYS.deployer, liveMarket, liveMarketAbi as Abi, "setForwarder", [privateKeyToAccount(KEYS.deployer).address]);
    await expect(runner.run(requestTx)).rejects.toThrow(/ReportProcessed result=false/);
    expect(await status(ids[0]!)).toBe("OPEN");
  }, 30_000);
});
