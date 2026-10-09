import { expect, test } from "bun:test";
import { redact } from "../src/log.ts";

test("redact: path, query, dan userinfo URL RPC/WS dihapus; host tetap untuk diagnosis", () => {
  expect(redact("HTTP request failed.\nURL: https://monad-testnet.g.alchemy.com/v2/AbCdSecret123\nRequest body: {}"))
    .toBe("HTTP request failed.\nURL: https://monad-testnet.g.alchemy.com/***\nRequest body: {}");
  expect(redact('{"wsUrl":"wss://rpc.example.io/ws?apikey=k3y"}')).toBe('{"wsUrl":"wss://rpc.example.io/***"}');
  expect(redact("https://user:pa55@rpc.example.io/")).toBe("https://rpc.example.io/");
  expect(redact("https://testnet-rpc.monad.xyz")).toBe("https://testnet-rpc.monad.xyz");
});

test("redact: URL Lichess (sumber publik di SOT) tidak diubah", () => {
  const url = "https://lichess.org/api/stream/broadcast/round/ZFuAnYX6.pgn";
  expect(redact(`stream ${url} putus`)).toBe(`stream ${url} putus`);
});
