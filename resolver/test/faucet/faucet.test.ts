import { describe, expect, test } from "bun:test";
import { createFaucet } from "../../src/faucet/faucet.ts";
import { FaucetError } from "../../src/contracts.ts";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const MON = 10n ** 18n;
const H = (n: number) => `0x${String(n).padStart(64, "0")}` as const;

function setup(o: { faucetBal?: bigint; userBal?: bigint } = {}) {
  const sent: { to: string; value: bigint }[] = [];
  const minted: string[] = [];
  let clock = 1_000_000;
  const f = createFaucet({
    usdcAmount: 50_000_000n, monAmountWei: MON / 2n,
    mintUsdc: async (to) => { minted.push(to); return H(minted.length); },
    sendMon: async (to, value) => { sent.push({ to, value }); return H(100 + sent.length); },
    faucetBalance: async () => o.faucetBal ?? 20n * MON,
    balanceOf: async () => o.userBal ?? 0n,
    now: () => clock,
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
    const { f, sent } = setup({ faucetBal: 10n * MON + MON / 2n - 1n });
    expect(await f.onboard(A, "ip")).toEqual({ usdcTx: H(1), monTx: null });
    expect(sent).toHaveLength(0);
    expect((await f.onboard(A, "ip")).usdcTx).toBe(H(2)); // boleh coba lagi
  });

  test("5 kali per IP per 24 jam", async () => {
    const { f } = setup();
    for (let i = 0; i < 5; i++) await f.onboard(`0x${String(i + 1).padStart(40, "0")}` as `0x${string}`, "9.9.9.9");
    expect(await status(f.onboard(B, "9.9.9.9"))).toBe(429);
  });
});

describe("Faucet topUpGas", () => {
  test("409 kalau saldo masih di atas ambang", async () => {
    const { f } = setup({ userBal: MON / 20n });
    expect(await status(f.topUpGas(A))).toBe(409);
  });

  test("kirim gasTopUpWei, maksimal 3 per alamat per 24 jam dengan kode GAS_TOPUP_LIMIT, kuota terpisah", async () => {
    const { f, sent } = setup({ userBal: 0n });
    await f.onboard(A, "ip");
    for (let i = 0; i < 3; i++) await f.topUpGas(A);
    expect(sent.slice(1).every((s) => s.value === MON / 2n)).toBe(true);
    const err = await f.topUpGas(A).catch((e) => e);
    expect(err).toBeInstanceOf(FaucetError);
    expect([err.status, err.code]).toEqual([429, "GAS_TOPUP_LIMIT"]);
  });
});
