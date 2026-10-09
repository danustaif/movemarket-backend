import { expect, test } from "bun:test";
import { parseGwei } from "viem";
import { lockMarketsFees } from "../../src/chain/clients.ts";

test("priority fee lockMarkets dari SOT gas.lockMarketsPriorityFee: estimasi x 2 + 1 gwei", () => {
  expect(lockMarketsFees({ maxPriorityFeePerGas: parseGwei("2"), maxFeePerGas: parseGwei("100") })).toEqual({
    maxPriorityFeePerGas: parseGwei("5"),
    maxFeePerGas: parseGwei("105"),
  });
});
