import test from "node:test";
import assert from "node:assert/strict";
import { safeEqual } from "../src/worker.js";

test("safeEqual accepts identical non-empty PINs", () => {
  assert.equal(safeEqual("482913", "482913"), true);
});

test("safeEqual rejects missing and different PINs", () => {
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual("482913", "482914"), false);
  assert.equal(safeEqual("123", "1234"), false);
});
