const pino = require("pino");
const { loadConfig } = require("./config/env");
const { SqliteStore } = require("./storage/sqliteStore");
const { AppsScriptClient } = require("./appsScript/client");
const { CaptureService } = require("./capture/captureService");
const { DryRunDiscordAdapter, DiscordThreadAdapter } = require("./discord/adapter");
const { startDiscordBot } = require("./discord/bot");

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const store = new SqliteStore(config.sqlitePath);
  const appsScriptClient = new AppsScriptClient(config.appsScript);
  const discordAdapter = config.discordEnabled
    ? new DiscordThreadAdapter({ config })
    : new DryRunDiscordAdapter();
  const captureService = new CaptureService({
    store,
    appsScriptClient,
    discordAdapter,
    logger,
    dryRun: config.appsScriptDryRun
  });

  logger.info({
    discordEnabled: config.discordEnabled,
    appsScriptDryRun: config.appsScriptDryRun,
    sqlitePath: config.sqlitePath
  }, "Starting LLC Inventory v2.");

  await startDiscordBot({ config, logger, captureService });

  const interval = setInterval(() => {
    captureService.processNextJob().catch((error) => {
      logger.error({ err: error }, "Background job loop failed.");
    });
  }, 1000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    store.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
