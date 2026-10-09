// Hasil sementara (RESOLVER_SERVICE 2.4): resolve() atas snapshot stream. Pemilihan pasar dilakukan engine.
import { resolve, type ResolveOutcome } from "@movemarket/shared";
import type { GameState, TrackedMarket } from "../contracts.ts";

/** Pasar yang hasil resolve()-nya berbeda dari provisional tersimpan. */
export function provisionalChanges(state: GameState, markets: readonly TrackedMarket[]): { id: bigint; outcome: ResolveOutcome }[] {
  const out: { id: bigint; outcome: ResolveOutcome }[] = [];
  for (const m of markets) {
    const outcome = resolve(state, m);
    if (outcome !== m.provisional) out.push({ id: m.id, outcome });
  }
  return out;
}
