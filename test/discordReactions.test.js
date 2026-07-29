const test = require("node:test");
const assert = require("node:assert/strict");
const { getCountReaction } = require("../src/discord/bot");

test("maps QR counts to Discord count reactions", () => {
  assert.equal(getCountReaction(1), "1\ufe0f\u20e3");
  assert.equal(getCountReaction(2), "2\ufe0f\u20e3");
  assert.equal(getCountReaction(10), "\ud83d\udd1f");
  assert.equal(getCountReaction(11), "\ud83d\udd22");
});
