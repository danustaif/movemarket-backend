import { describe, expect, test } from "bun:test";
import { parseCreOutput, createCreRunner } from "../../src/cre/runner.ts";

const TX = "0x" + "ab".repeat(32);

describe("parseCreOutput", () => {
  test("membaca string JSON setelah 'Workflow Simulation Result:'", () => {
    const out = [
      "Workflow compiled",
      "[SIMULATION] Running trigger trigger=evm@1.0.0",
      '[USER LOG] {"gameRef":"lichess:game:aaaaaaaa"} bukan hasil',
      "Workflow Simulation Result:",
      ` "{\\"gameRef\\":\\"lichess:game:e9SJcXpJ\\",\\"resolved\\":3,\\"skipped\\":1,\\"txHash\\":\\"${TX}\\"}"`,
      "[SIMULATION] Execution finished signal received",
    ].join("\n");
    expect(parseCreOutput(out)).toEqual({ gameRef: "lichess:game:e9SJcXpJ", resolved: 3, skipped: 1, txHash: TX as `0x${string}` });
  });

  test("hasil local-simulation dengan note, tanpa txHash", () => {
    const out = 'Workflow Simulation Result:\n "{\\"gameRef\\":\\"g\\",\\"resolved\\":0,\\"skipped\\":0,\\"note\\":\\"nothing to resolve\\"}"\n';
    expect(parseCreOutput(out)).toEqual({ gameRef: "g", resolved: 0, skipped: 0, note: "nothing to resolve" });
  });

  test("tanpa penanda hasil atau bentuk salah: null", () => {
    expect(parseCreOutput('[USER LOG] {"gameRef":"x","resolved":1,"skipped":0}')).toBeNull();
    expect(parseCreOutput('Workflow Simulation Result:\n "hello"')).toBeNull();
  });
});

describe("createCreRunner", () => {
  test("perintah sesuai RESOLVER_SERVICE 2.7 dan konkurensi 1", async () => {
    const calls: string[][] = [];
    let active = 0, maxActive = 0;
    const runner = createCreRunner({
      projectDir: "/cre", target: "staging-settings", timeoutSec: 5,
      exec: async (cmd) => {
        calls.push(cmd); active++; maxActive = Math.max(maxActive, active);
        await Bun.sleep(5); active--;
        return { exitCode: 0, stdout: 'Workflow Simulation Result:\n "{\\"gameRef\\":\\"g\\",\\"resolved\\":1,\\"skipped\\":0}"', stderr: "" };
      },
    });
    const [a] = await Promise.all([runner.run(TX as `0x${string}`), runner.run(TX as `0x${string}`)]);
    expect(a.resolved).toBe(1);
    expect(maxActive).toBe(1);
    expect(calls[0]).toEqual([
      "cre", "workflow", "simulate", "resolver-workflow", "--target", "staging-settings", "--non-interactive",
      "--trigger-index", "0", "--evm-tx-hash", TX, "--evm-event-index", "0", "--broadcast",
    ]);
  });

  test("exit code bukan 0 atau output tanpa hasil: reject", async () => {
    const runner = createCreRunner({
      projectDir: "/cre", target: "t", timeoutSec: 5,
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
    });
    await expect(runner.run(TX as `0x${string}`)).rejects.toThrow(/exit 1/);
  });
});
