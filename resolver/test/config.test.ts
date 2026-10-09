import { describe, expect, test } from "bun:test";
import { loadConfig, privateKey } from "../src/config.ts";

describe("config", () => {
  test("default dari SOT, env kosong = tidak diisi, alamat hilang = mode terbatas", () => {
    const c = loadConfig({ MONAD_TESTNET_WS: "", LIVE_MARKET_ADDRESS: "", ADMIN_TOKEN: "rahasia" });
    expect(c.port).toBe(8787);
    expect(c.replay.startPly).toBe(20);
    expect(c.faucet.usdcAmount).toBe(50_000_000n);
    expect(c.missing).toEqual(["LIVE_MARKET_ADDRESS", "MOCK_USDC_ADDRESS", "DEPLOY_BLOCK"]);
    expect(JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("rahasia");
  });

  test("override env dan REPLAY_POOL dipisah koma", () => {
    const c = loadConfig({
      PORT: "9000", REPLAY_POOL: "aaaaaaaa, bbbbbbbb,", DEPLOY_BLOCK: "123",
      LIVE_MARKET_ADDRESS: "0x0000000000000000000000000000000000000001",
      MOCK_USDC_ADDRESS: "0x0000000000000000000000000000000000000002",
    });
    expect(c.port).toBe(9000);
    expect(c.replayPool).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    expect(c.deployBlock).toBe(123n);
    expect(c.missing).toEqual([]);
  });

  test("nilai salah: pesan berisi nama env saja", () => {
    expect(() => loadConfig({ LIVE_MARKET_ADDRESS: "0xnope" })).toThrow("LIVE_MARKET_ADDRESS");
    expect(() => privateKey("RESOLVER_PRIVATE_KEY", { RESOLVER_PRIVATE_KEY: "0x1234" })).toThrow(/^RESOLVER_PRIVATE_KEY/);
    try { privateKey("RESOLVER_PRIVATE_KEY", { RESOLVER_PRIVATE_KEY: "0xdeadbeef" }); } catch (e) {
      expect(String(e)).not.toContain("deadbeef");
    }
  });
});
