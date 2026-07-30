import test from "node:test";
import assert from "node:assert/strict";
import worker, { normalizeCardId, safeEqual } from "../src/worker.js";

test("safeEqual accepts identical non-empty PINs", () => {
  assert.equal(safeEqual("482913", "482913"), true);
});

test("safeEqual rejects missing and different PINs", () => {
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual("482913", "482914"), false);
  assert.equal(safeEqual("123", "1234"), false);
});

test("normalizeCardId trims and uppercases card IDs", () => {
  assert.equal(normalizeCardId(" al-s-e51f26cf "), "AL-S-E51F26CF");
});

test("session endpoint rejects missing configuration", async () => {
  const response = await worker.fetch(new Request("https://scanner.test/api/session"), {}, {});
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.ok, false);
});

test("session endpoint rejects an incorrect PIN", async () => {
  const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
  const response = await worker.fetch(new Request("https://scanner.test/api/session", {
    headers: { "X-App-Pin": "000000" }
  }), env, {});
  const data = await response.json();
  assert.equal(response.status, 401);
  assert.equal(data.ok, false);
});

test("lookup validates cardId before calling Apps Script", async () => {
  const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
  const response = await worker.fetch(new Request("https://scanner.test/api/lookup", {
    headers: { "X-App-Pin": "482913" }
  }), env, {});
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.equal(data.ok, false);
});

test("POST-only endpoints reject wrong methods", async () => {
  const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
  const response = await worker.fetch(new Request("https://scanner.test/api/audit/start", {
    method: "GET",
    headers: { "X-App-Pin": "482913" }
  }), env, {});
  const data = await response.json();
  assert.equal(response.status, 405);
  assert.equal(data.ok, false);
});
