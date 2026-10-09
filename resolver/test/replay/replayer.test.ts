import { describe, expect, test } from "bun:test";
import { createReplayer } from "../../src/replay/replayer.ts";
import type { GameUpdate } from "../../src/contracts.ts";

const FIX = new URL("../../../../source/sot/fixtures/lichess/", import.meta.url);
const rapidLive = await Bun.file(new URL("game-export.ongoing-rapid.json", FIX)).json();
const rapid = { ...rapidLive, status: "resign", winner: "black" }; // 44 ply, selesai
const bullet = await Bun.file(new URL("game-export.finished-mate.json", FIX)).json();

function setup(o: { viewers?: number; live?: number; stakes?: boolean; pool?: string[] } = {}) {
  let clock = 0;
  const env = { viewers: o.viewers ?? 1, live: o.live ?? 0, stakes: o.stakes ?? false };
  const updates: GameUpdate[] = [];
  const sse: string[] = [];
  const logs: string[] = [];
  const spawning: string[] = [];
  const r = createReplayer({
    fetchGame: async (id) => (id === rapid.id ? rapid : bullet),
    onUpdate: (u) => updates.push(u),
    newRun: () => {},
    sse: { publish: (e, d) => sse.push(`${e}:${(d as { gameRef: string }).gameRef}`), viewers: () => env.viewers },
    engine: { setSpawning: (ref, b) => spawning.push(`${ref}:${b}`) },
    hasPendingStakes: () => env.stakes,
    liveGames: () => env.live,
    pool: o.pool ?? [],
    startPly: 20, plyIntervalSec: 20, autoIdleMin: 10, requiresViewer: true, viewerGraceSec: 120,
    log: (e) => logs.push(e),
    now: () => clock,
  });
  const run = async (sec: number) => { for (let i = 0; i < sec; i++) { clock += 1000; await r.tick(); } };
  return { r, env, updates, sse, logs, spawning, run };
}

describe("Replayer", () => {
  test("mulai di REPLAY_START_PLY, maju satu ply per interval, selesai dengan hasil", async () => {
    const { r, updates, sse, run } = setup();
    expect(await r.start("ymG9hwyh")).toBe("lichess:game:ymG9hwyh");
    expect(sse).toEqual(["replay_starting:lichess:game:ymG9hwyh"]);
    expect(updates[0]).toMatchObject({ isReplay: true, source: "replay", speed: "rapid", ended: false });
    expect(updates[0]!.sans).toHaveLength(20);
    await run(20);
    expect(updates.at(-1)!.sans).toHaveLength(21);
    await run(24 * 20);
    expect(updates.at(-1)).toMatchObject({ ended: true, result: "0-1" });
    expect(updates.at(-1)!.sans).toHaveLength(44);
    expect(r.active()).toBeNull();
  });

  test("selain classical/rapid ditolak dengan log replay_rejected", async () => {
    const { r, logs, updates } = setup();
    await expect(r.start("e9SJcXpJ")).rejects.toThrow(/replay_rejected/);
    expect(logs).toContain("replay_rejected");
    expect(updates).toHaveLength(0);
  });

  test("scheduler: idle AUTO_REPLAY_IDLE_MIN tanpa partai live dan ada penonton -> replay dari pool", async () => {
    const noViewer = setup({ viewers: 0, pool: ["ymG9hwyh"] });
    await noViewer.run(11 * 60);
    expect(noViewer.r.active()).toBeNull();

    const s = setup({ pool: ["ymG9hwyh"] });
    await s.run(9 * 60);
    expect(s.r.active()).toBeNull();
    await s.run(61);
    expect(s.r.active()).toBe("lichess:game:ymG9hwyh");
  });

  test("tanpa penonton VIEWER_GRACE_SEC: berhenti spawn, maju selama ada stake, lalu jeda; penonton kembali -> lanjut", async () => {
    const s = setup({ stakes: true });
    await s.r.start("ymG9hwyh");
    s.env.viewers = 0;
    await s.run(121);
    expect(s.spawning).toEqual(["lichess:game:ymG9hwyh:true", "lichess:game:ymG9hwyh:false"]);
    const n = s.updates.length;
    await s.run(40);
    expect(s.updates.length).toBe(n + 2); // masih maju karena ada stake
    s.env.stakes = false;
    await s.run(60);
    const paused = s.updates.length;
    await s.run(60);
    expect(s.updates.length).toBe(paused);
    s.env.viewers = 1;
    await s.run(21);
    expect(s.spawning.slice(1)).toEqual(["lichess:game:ymG9hwyh:false", "lichess:game:ymG9hwyh:true"]);
    expect(s.updates.length).toBeGreaterThan(paused);
  });

  test("replay yang dimulai tanpa penonton tidak membuat pasar sejak update pertama", async () => {
    const s = setup({ viewers: 0 });
    await s.run(121);
    await s.r.start("ymG9hwyh");
    expect(s.spawning).toEqual(["lichess:game:ymG9hwyh:false"]);
  });
});
