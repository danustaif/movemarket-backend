import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// config.selfhost.yaml = config.yaml + blok `rpc` cadangan (HyperSync tetap sumber utama). Selain itu wajib identik.
const strip = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .map((l) => l.replace(/\s+#.*$/, ""))
    .join("\n");

test("config.selfhost.yaml hanya menambah rpc for: fallback ke config.yaml", () => {
  const base = strip(readFileSync("config.yaml", "utf8"));
  const self = strip(readFileSync("config.selfhost.yaml", "utf8"))
    .replace(/\n    rpc:\n      - url: \$\{ENVIO_RPC_URL:-[^}]+\}\n        for: fallback/, "");
  expect(self).toBe(base);
});
