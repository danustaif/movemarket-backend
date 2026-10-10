import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// config.selfhost.yaml = config.yaml + blok `rpc` (sumber RPC tanpa token HyperSync). Selain itu wajib identik.
const strip = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .map((l) => l.replace(/\s+#.*$/, ""))
    .join("\n");

test("config.selfhost.yaml hanya menambah rpc for: sync ke config.yaml", () => {
  const base = strip(readFileSync("config.yaml", "utf8"));
  const self = strip(readFileSync("config.selfhost.yaml", "utf8"))
    .replace(/\n    rpc:\n      - url: \$\{ENVIO_RPC_URL:-[^}]+\}\n        for: sync/, "");
  expect(self).toBe(base);
});
