// Runner CRE untuk CRE_MODE=simulate (RESOLVER_SERVICE.md 2.7). Dipanggil hanya untuk ResolutionRequested
// yang bloknya sudah finalized (SOT D20). Konkurensi 1 (CRE_RUN_CONCURRENCY), timeout CRE_RUN_TIMEOUT_SEC.
import { SOT, type CreHandlerResult } from "@movemarket/shared";
import type { Hex } from "viem";
import type { CreRunner } from "../contracts.ts";

export type Exec = (cmd: string[], opts: { cwd: string; timeoutMs: number }) =>
  Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

const MARKER = "Workflow Simulation Result:";
const SECRET_ENV = ["RESOLVER_PRIVATE_KEY", "FAUCET_PRIVATE_KEY", "ADMIN_TOKEN"];

/** Ambil nilai kembali handler: baris setelah penanda, string JSON (bisa di-encode dua kali). */
export function parseCreOutput(stdout: string): CreHandlerResult | null {
  const lines = stdout.split("\n");
  const i = lines.findIndex((l) => l.includes(MARKER));
  if (i < 0) return null;
  const raw = lines.slice(i + 1).find((l) => l.trim() !== "");
  if (!raw) return null;
  try {
    let v: unknown = JSON.parse(raw.trim());
    if (typeof v === "string") v = JSON.parse(v);
    const r = v as Partial<CreHandlerResult>;
    if (typeof r !== "object" || r === null || typeof r.gameRef !== "string") return null;
    if (typeof r.resolved !== "number" || typeof r.skipped !== "number") return null;
    return r as CreHandlerResult;
  } catch {
    return null;
  }
}

/** Bun.spawn tanpa secret resolver di env anak; CLI membaca CRE_ETH_PRIVATE_KEY dari .env proyek CRE. */
export const bunExec: Exec = async (cmd, { cwd, timeoutMs }) => {
  const env = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

export function createCreRunner(o: { projectDir: string; target: string; timeoutSec?: number; exec?: Exec }): CreRunner {
  const exec = o.exec ?? bunExec;
  const timeoutMs = (o.timeoutSec ?? SOT.resolver.CRE_RUN_TIMEOUT_SEC) * 1000;
  let tail: Promise<unknown> = Promise.resolve(); // ponytail: konkurensi 1 = rantai promise

  const runOnce = async (txHash: Hex): Promise<CreHandlerResult> => {
    const cmd = [
      "cre", "workflow", "simulate", SOT.cre.workflowName, "--target", o.target, "--non-interactive",
      "--trigger-index", "0", "--evm-tx-hash", txHash, "--evm-event-index", "0", "--broadcast",
    ];
    const r = await exec(cmd, { cwd: o.projectDir, timeoutMs });
    if (r.exitCode !== 0) throw new Error(`cre simulate exit ${r.exitCode}: ${r.stderr.slice(-500)}`);
    const parsed = parseCreOutput(r.stdout);
    if (!parsed) throw new Error(`cre simulate tanpa hasil handler: ${r.stdout.slice(-500)}`);
    return parsed;
  };

  return {
    run(txHash) {
      const p = tail.then(() => runOnce(txHash));
      tail = p.catch(() => undefined);
      return p;
    },
  };
}
