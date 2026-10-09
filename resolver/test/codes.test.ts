import { expect, test } from "bun:test";
import { STATUS_OPEN, isMismatch } from "../src/markets/codes.ts";
import { market } from "./helpers.ts";

test("STATUS_OPEN dari ENUMS.Status", () => {
  expect(STATUS_OPEN).toBe(0);
});

test("mismatch final vs sementara; VOID NO_WINNERS (2) cocok dengan YES/NO, alasan void lain tidak", () => {
  expect(isMismatch(market({ final: "YES", provisional: "YES" }))).toBe(false);
  expect(isMismatch(market({ final: "NO", provisional: "YES" }))).toBe(true);
  expect(isMismatch(market({ final: "VOID", voidReason: 2, provisional: "NO" }))).toBe(false);
  expect(isMismatch(market({ final: "VOID", voidReason: 2, provisional: "PENDING" }))).toBe(true);
  expect(isMismatch(market({ final: "VOID", voidReason: 1, provisional: "YES" }))).toBe(true);
  expect(isMismatch(market({ final: "VOID", voidReason: 3, provisional: "VOID" }))).toBe(false);
});
