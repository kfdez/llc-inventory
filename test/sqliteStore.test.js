const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SqliteStore } = require("../src/storage/sqliteStore");

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llc-inventory-v2-"));
  return new SqliteStore(path.join(dir, "test.sqlite"));
}

test("creates and updates jobs", () => {
  const store = createStore();
  const job = store.createJob({
    type: "capture.start",
    state: "pending",
    payload: { sessionName: "Saturday" }
  });
  assert.equal(job.type, "capture.start");
  assert.equal(job.payload.sessionName, "Saturday");

  const updated = store.updateJob(job.id, {
    state: "completed",
    result: { ok: true }
  });
  assert.equal(updated.state, "completed");
  assert.equal(updated.result.ok, true);
  store.close();
});

test("claims eligible jobs", () => {
  const store = createStore();
  store.createJob({
    type: "capture.start",
    state: "pending",
    payload: {}
  });
  const claimed = store.claimNextJob({
    type: "capture.start",
    states: ["pending"],
    leaseMs: 10000,
    nowMs: Date.now()
  });
  assert.equal(claimed.type, "capture.start");
  assert.equal(claimed.attempts, 1);

  const secondClaim = store.claimNextJob({
    type: "capture.start",
    states: ["pending"],
    leaseMs: 10000,
    nowMs: Date.now()
  });
  assert.equal(secondClaim, null);
  store.close();
});
