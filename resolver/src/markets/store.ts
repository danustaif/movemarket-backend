// State pasar dan posisi di memori, dibangun dari event LiveMarket (cadangan indexer untuk GET /positions/:address).
import { ENUMS, type OutcomeCode, type PositionDto, type ResolveOutcome, type VoidReasonCode } from "@movemarket/shared";
import type { Address } from "viem";
import type { LiveMarketEvent, MarketStore, TrackedMarket } from "../contracts.ts";
import { statusOf } from "./codes.ts";

/** LiveMarket.claimable(id, user), diinjeksi supaya store tidak membuat client sendiri. */
export type ClaimableReader = (id: bigint, user: Address) => Promise<bigint>;

interface Stake { yes: bigint; no: bigint; settled: boolean }

export class MemoryMarketStore implements MarketStore {
  private markets = new Map<bigint, TrackedMarket>();
  /** id -> alamat lowercase -> stake */
  private stakes = new Map<bigint, Map<string, Stake>>();
  /** Watcher mengirim tiap event dua kali (proposed lalu finalized, SOT D20); apply harus idempoten. */
  private seen = new Set<string>();

  constructor(private readonly claimable: ClaimableReader) {}

  apply(ev: LiveMarketEvent): void {
    const key = `${ev.txHash}:${ev.name}:${JSON.stringify(ev.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    switch (ev.name) {
      case "MarketCreated": {
        const a = ev.args;
        this.markets.set(a.id, {
          id: a.id, gameRef: a.gameRef, marketType: a.marketType as TrackedMarket["marketType"], side: a.side as TrackedMarket["side"],
          fromPly: a.fromPly, toPly: a.toPly, lockTime: Number(a.lockTime), resolveDeadline: Number(a.resolveDeadline),
          poolYes: 0n, poolNo: 0n, provisional: "PENDING", requested: false, final: null, voidReason: null,
        });
        return;
      }
      case "MarketLocked":
        return this.patch(ev.args.id, { lockTime: Number(ev.args.lockTime) });
      case "BetPlaced": {
        const { id, user, yes, amount, poolYes, poolNo } = ev.args;
        this.patch(id, { poolYes, poolNo });
        const s = this.stake(id, user);
        if (yes) s.yes += amount;
        else s.no += amount;
        return;
      }
      case "ResolutionRequested":
        for (const id of ev.args.ids) this.patch(id, { requested: true });
        return;
      case "MarketResolved": {
        const name = ENUMS.Outcome[ev.args.outcome];
        if (name && name !== "NONE") this.patch(ev.args.id, { final: name });
        return;
      }
      case "MarketVoided":
        return this.patch(ev.args.id, { final: "VOID", voidReason: ev.args.reason as VoidReasonCode });
      case "Claimed":
      case "Refunded":
        this.stake(ev.args.id, ev.args.user).settled = true;
        return;
    }
  }

  setProvisional(id: bigint, outcome: ResolveOutcome): void {
    this.patch(id, { provisional: outcome });
  }

  get(id: bigint): TrackedMarket | undefined {
    return this.markets.get(id);
  }

  all(): TrackedMarket[] {
    return [...this.markets.values()];
  }

  byGame(gameRef: string): TrackedMarket[] {
    return this.all().filter((m) => m.gameRef === gameRef);
  }

  async positions(address: Address): Promise<PositionDto[]> {
    const user = address.toLowerCase();
    const out: Promise<PositionDto>[] = [];
    for (const [id, byUser] of this.stakes) {
      const s = byUser.get(user);
      const m = this.markets.get(id);
      if (!s || !m) continue;
      out.push((async () => ({
        marketId: id.toString(), gameRef: m.gameRef, stakeYes: s.yes.toString(), stakeNo: s.no.toString(),
        status: statusOf(m.final), outcome: ENUMS.Outcome.indexOf(m.final ?? "NONE") as OutcomeCode,
        resolveDeadline: m.resolveDeadline, settled: s.settled,
        // Hanya pasar final dan belum diklaim yang dibaca dari kontrak; sisanya pasti 0.
        claimable: (m.final !== null && !s.settled ? await this.claimable(id, address) : 0n).toString(),
      }))());
    }
    return Promise.all(out);
  }

  private patch(id: bigint, p: Partial<TrackedMarket>): void {
    const m = this.markets.get(id);
    if (m) Object.assign(m, p);
  }

  private stake(id: bigint, user: Address): Stake {
    let byUser = this.stakes.get(id);
    if (!byUser) this.stakes.set(id, (byUser = new Map()));
    let s = byUser.get(user.toLowerCase());
    if (!s) byUser.set(user.toLowerCase(), (s = { yes: 0n, no: 0n, settled: false }));
    return s;
  }
}
