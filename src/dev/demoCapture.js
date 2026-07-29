const fs = require("fs");
const os = require("os");
const path = require("path");
const pino = require("pino");
const { SqliteStore } = require("../storage/sqliteStore");
const { CaptureService } = require("../capture/captureService");
const { DryRunDiscordAdapter } = require("../discord/adapter");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llc-inventory-v2-demo-"));
  const store = new SqliteStore(path.join(dir, "demo.sqlite"));
  const logger = pino({ level: "warn" });
  const service = new CaptureService({
    store,
    logger,
    dryRun: true,
    appsScriptClient: {},
    discordAdapter: new DryRunDiscordAdapter()
  });

  const start = service.requestStart({
    organizerKey: "nace",
    sessionName: "Demo Capture",
    requestedBy: "demo"
  });
  console.log("Queued start job:", start.job.id);
  await service.processNextJob();
  console.log("After start:", service.getStatus().activeSession);

  const stop = service.requestStopLatest({ requestedBy: "demo" });
  console.log("Queued stop job:", stop.job.id);
  await service.processNextJob();
  console.log("After stop:", store.getCaptureSession(start.session.id));

  store.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
