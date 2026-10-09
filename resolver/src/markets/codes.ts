// Kode enum kontrak dibaca dari SOT (ENUMS), bukan angka langsung.
import { ENUMS, type FinalOutcome, type StatusCode, type VoidReasonCode } from "@movemarket/shared";
import type { TrackedMarket } from "../contracts.ts";

export const STATUS_OPEN = ENUMS.Status.indexOf("OPEN") as StatusCode;
export const VOID_NO_WINNERS = Number(Object.entries(ENUMS.VoidReason).find(([, name]) => name === "NO_WINNERS")![0]) as VoidReasonCode;

export const statusOf = (final: FinalOutcome | null) =>
  ENUMS.Status.indexOf(final === null ? "OPEN" : final === "VOID" ? "VOIDED" : "RESOLVED") as StatusCode;

/** Hasil final berbeda dari hasil sementara. VOID NO_WINNERS dihitung cocok dengan YES/NO (RESOLVER_SERVICE 2.6). */
export function isMismatch(m: Pick<TrackedMarket, "final" | "provisional" | "voidReason">): boolean {
  const noWinners = m.final === "VOID" && m.voidReason === VOID_NO_WINNERS && (m.provisional === "YES" || m.provisional === "NO");
  return m.final !== m.provisional && !noWinners;
}
