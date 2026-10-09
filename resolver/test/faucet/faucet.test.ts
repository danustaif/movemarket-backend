import { describe, expect, test } from "bun:test";
import { SOT } from "@movemarket/shared";
import { createFaucet } from "../../src/faucet/faucet.ts";
import { FaucetError } from "../../src/contracts.ts";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const MON = 10n ** 18n;
const H = (n: number) => `0x${String(n).padStart(64, "0")}` as const;

function setup(o: { faucetBal?: bigint; userBal?: bigint; gate?: Promise<void>; failMint?: boolean; shared?: boolean } = {}) {
  const sent: { to: string; value: bigint }[] = [];
  const minted: string[] = [];
  let clock = 1_000_000;
  const f = createFaucet({
    usdcAmount: 50_000_000n, monAmountWei: MON / 2n,
    mintUsdc: async (to) => {
      await o.gate;
      if (o.failMint) throw new Error("mint revert");
      minted.push(to); return H(minted.length);
    },
    sendMon: async (to, value) => { await o.gate; sent.push({ to, value }); return H(100 + sent.length); },
    faucetBalance: async () => o.faucetBal ?? 20n * MON,
    balanceOf: async () => o.userBal ?? 0n,
    now: () => clock,
    sharesResolverWallet: o.shared,
  });
  return { f, sent, minted, advance: (ms: number) => (clock += ms) };
}

const status = (p: Promise<unknown>) => p.then(() => 0, (e) => (e instanceof FaucetError ? e.status : -1));

describe("Faucet onboard", () => {
  test("mint tUSDC + kirim MON; alamat sama kedua kali 429; reset setelah 24 jam", async () => {
    const { f, sent, advance } = setup();
    expect(await f.onboard(A, "1.1.1.1")).toEqual({ usdcTx: H(1), monTx: H(101) });
    expect(sent).toEqual([{ to: A, value: MON / 2n }]);
    expect(await status(f.onboard(A, "2.2.2.2"))).toBe(429);
    advance(24 * 3600 * 1000 + 1);
    expect((await f.onboard(A, "2.2.2.2")).monTx).toBe(H(102));
  });

  test("alamat tidak valid 400", async () => {
    const { f } = setup();
    expect(await status(f.onboard("0x123" as `0x${string}`, "ip"))).toBe(400);
  });

  test("wallet faucet di bawah 10 MON + jumlah kirim: hanya tUSDC, kuota alamat tidak terpakai", async () => {
    const o = { faucetBal: 10n * MON + MON / 2n - 1n };
    const { f, sent, minted } = setup(o);
    expect(await f.onboard(A, "ip")).toEqual({ usdcTx: H(1), monTx: null });
    expect(sent).toHaveLength(0);
    // Coba lagi: tUSDC tidak di-mint ulang (kuota tUSDC terpisah), usdcTx lama dikembalikan, MON dicoba lagi.
    expect(await f.onboard(A, "ip")).toEqual({ usdcTx: H(1), monTx: null });
    o.faucetBal = 20n * MON;
    expect(await f.onboard(A, "ip2")).toEqual({ usdcTx: H(1), monTx: H(101) });
    expect(minted).toEqual([A]);
    expect(await status(f.onboard(A, "ip3"))).toBe(429);
  });

  test("wallet faucet = wallet resolver: lantai minResolverMonWei + jumlah kirim, bukan reserve 10 MON", async () => {
    const floor = BigInt(SOT.faucet.minResolverMonWei) + MON / 2n;
    // 15 MON cukup untuk wallet faucet terpisah, tapi akan menurunkan resolver di bawah 20 MON.
    const low = setup({ faucetBal: 15n * MON, shared: true });
    expect((await low.f.onboard(A, "1.1.1.1")).monTx).toBeNull();
    expect(low.sent).toEqual([]);
    const ok = setup({ faucetBal: floor, shared: true });
    expect((await ok.f.onboard(A, "1.1.1.1")).monTx).toBe(H(101));
    // Isi ulang gas memakai lantai yang sama.
    expect(await status(setup({ faucetBal: 15n * MON, shared: true }).f.topUpGas(A, "1.1.1.1"))).toBe(429);
    // Tanpa flag, 15 MON tetap boleh mengirim.
    expect((await setup({ faucetBal: 15n * MON }).f.onboard(A, "1.1.1.1")).monTx).toBe(H(101));
  });

  test("mint gagal: kuota tidak terpakai", async () => {
    const o = { failMint: true };
    const { f } = setup(o);
    expect(await status(f.onboard(A, "ip"))).toBe(-1);
    o.failMint = false;
    expect((await f.onboard(A, "ip")).monTx).toBe(H(101));
  });

  test("request paralel dari IP yang sama tidak melewati batas (reservasi sebelum await)", async () => {
    let open!: () => void;
    const { f, minted } = setup({ gate: new Promise<void>((r) => (open = r)) });
    const addrs = Array.from({ length: 8 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}` as `0x${string}`);
    const all = addrs.map((a) => status(f.onboard(a, "9.9.9.9")));
    open();
    const codes = await Promise.all(all);
    expect(codes.filter((c) => c === 0)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(3);
    expect(minted).toHaveLength(5);
  });

  test("5 kali per IP per 24 jam", async () => {
    const { f } = setup();
    for (let i = 0; i < 5; i++) await f.onboard(`0x${String(i + 1).padStart(40, "0")}` as `0x${string}`, "9.9.9.9");
    expect(await status(f.onboard(B, "9.9.9.9"))).toBe(429);
  });
});

const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof FaucetError ? `${e.status}:${e.code}` : "other"));

test("setiap 429 onboarding membawa kode FAUCET_FAILED (USER_FLOW: faucet gagal / limit); request bersamaan juga", async () => {
  let open!: () => void;
  const { f, advance } = setup({ gate: new Promise<void>((r) => (open = r)) });
  const first = f.onboard(A, "ip");
  expect(await errCode(f.onboard(A, "ip"))).toBe("429:FAUCET_FAILED"); // alamat sedang diproses
  expect(await errCode(f.topUpGas(A, "ip"))).toBe("429:FAUCET_FAILED");
  open();
  await first;
  expect(await errCode(f.onboard(A, "ip"))).toBe("429:FAUCET_FAILED"); // kuota alamat
  advance(1);
  for (let i = 0; i < 4; i++) await f.onboard(`0x${String(i + 1).padStart(40, "0")}` as `0x${string}`, "ip");
  expect(await errCode(f.onboard(B, "ip"))).toBe("429:FAUCET_FAILED"); // kuota IP
});

describe("Faucet topUpGas", () => {
  test("409 kalau saldo masih di atas ambang", async () => {
    const { f } = setup({ userBal: MON / 20n });
    expect(await status(f.topUpGas(A, "ip"))).toBe(409);
  });

  test("kirim gasTopUpWei, maksimal 3 per alamat per 24 jam dengan kode GAS_TOPUP_LIMIT, kuota terpisah", async () => {
    const { f, sent } = setup({ userBal: 0n });
    await f.onboard(A, "ip");
    for (let i = 0; i < 3; i++) await f.topUpGas(A, "ip");
    expect(sent.slice(1).every((s) => s.value === MON / 2n)).toBe(true);
    const err = await f.topUpGas(A, "ip").catch((e) => e);
    expect(err).toBeInstanceOf(FaucetError);
    expect([err.status, err.code]).toEqual([429, "GAS_TOPUP_LIMIT"]);
  });

  test("kuota isi ulang gas per IP (perIpPer24h), juga untuk request paralel", async () => {
    let open!: () => void;
    const { f, sent } = setup({ userBal: 0n, gate: new Promise<void>((r) => (open = r)) });
    const addrs = Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}` as `0x${string}`);
    const all = addrs.map((a) => f.topUpGas(a, "6.6.6.6").then(() => 0, (e) => `${e.status}:${e.code}`));
    open();
    const codes = await Promise.all(all);
    expect(codes.filter((c) => c === 0)).toHaveLength(5);
    expect(codes.filter((c) => c === "429:GAS_TOPUP_LIMIT")).toHaveLength(2);
    expect(sent).toHaveLength(5);
  });
});
