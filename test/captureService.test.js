const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SqliteStore } = require("../src/storage/sqliteStore");
const { CaptureService } = require("../src/capture/captureService");
const { CAPTURE_STATES } = require("../src/capture/captureStates");

function createService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llc-inventory-v2-"));
  const store = new SqliteStore(path.join(dir, "test.sqlite"));
  const service = new CaptureService({
    store,
    dryRun: true,
    logger: { error() {} },
    appsScriptClient: {},
    discordAdapter: {
      async createCaptureThread() {
        return { id: "thread-1", name: "Thread One" };
      }
    }
  });
  return { store, service };
}

test("start job becomes active in dry run", async () => {
  const { store, service } = createService();
  const { session, job } = service.requestStart({
    organizerKey: "nace",
    sessionName: "Saturday",
    requestedBy: "Tester"
  });
  assert.equal(session.state, CAPTURE_STATES.START_REQUESTED);

  await service.processStartJob(job);
  const updated = store.getCaptureSession(session.id);
  assert.equal(updated.state, CAPTURE_STATES.ACTIVE);
  assert.equal(updated.discordThreadId, "thread-1");
  assert.equal(updated.appsScriptSession.sheet_tab_name, "DRY RUN");
  store.close();
});

test("stop latest active capture queues and completes stop job", async () => {
  const { store, service } = createService();
  const { session, job } = service.requestStart({
    organizerKey: "nace",
    sessionName: "Saturday",
    requestedBy: "Tester"
  });
  await service.processStartJob(job);

  const stop = service.requestStopLatest({ requestedBy: "Tester" });
  assert.equal(stop.session.state, CAPTURE_STATES.STOP_REQUESTED);

  await service.processStopJob(stop.job);
  const stopped = store.getCaptureSession(session.id);
  assert.equal(stopped.state, CAPTURE_STATES.STOPPED);
  store.close();
});

test("status returns working session and recent jobs", async () => {
  const { store, service } = createService();
  service.requestStart({
    organizerKey: "nace",
    sessionName: "Saturday",
    requestedBy: "Tester"
  });

  const status = service.getStatus();
  assert.equal(status.activeSession.state, CAPTURE_STATES.START_REQUESTED);
  assert.equal(status.recentJobs.length, 1);
  store.close();
});
