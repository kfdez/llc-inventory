const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function optionalEnv(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : String(value).trim();
}

function booleanEnv(name, fallback = false) {
  const value = optionalEnv(name, fallback ? "true" : "false").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function numberEnv(name, fallback) {
  const value = Number(optionalEnv(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function requireWhenEnabled(name, enabled) {
  const value = optionalEnv(name);
  if (enabled && !value) {
    throw new Error("Missing required environment variable: " + name);
  }
  return value;
}

function resolveOptionalPath(value) {
  const normalized = String(value || "").trim();
  return normalized ? path.resolve(process.cwd(), normalized) : "";
}

function loadConfig() {
  const legacyDryRun = booleanEnv("DRY_RUN", true);
  const discordEnabled = booleanEnv("DISCORD_ENABLED", !legacyDryRun);
  const appsScriptDryRun = booleanEnv("APPS_SCRIPT_DRY_RUN", legacyDryRun);
  const sqlitePath = path.resolve(process.cwd(), optionalEnv("SQLITE_PATH", "./data/llc-inventory-v2.sqlite"));

  return {
    env: optionalEnv("NODE_ENV", "development"),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    dryRun: legacyDryRun,
    discordEnabled,
    appsScriptDryRun,
    sqlitePath,
    appsScript: {
      baseUrl: requireWhenEnabled("APPS_SCRIPT_API_BASE_URL", !appsScriptDryRun),
      requestTimeoutMs: numberEnv("APPS_SCRIPT_REQUEST_TIMEOUT_MS", 45000)
    },
    discord: {
      botToken: requireWhenEnabled("DISCORD_BOT_TOKEN", discordEnabled),
      guildId: requireWhenEnabled("DISCORD_GUILD_ID", discordEnabled),
      commandsChannelId: optionalEnv("DISCORD_COMMANDS_CHANNEL_ID"),
      organizerChannels: {
        nace: optionalEnv("DISCORD_ORGANIZER_NACE_CHANNEL_ID"),
        cardfesta: optionalEnv("DISCORD_ORGANIZER_CARDFESTA_CHANNEL_ID"),
        other: optionalEnv("DISCORD_ORGANIZER_OTHER_CHANNEL_ID")
      }
    },
    imageUpload: {
      imgbbApiKey: optionalEnv("IMGBB_API_KEY")
    },
    imageAnalysis: {
      labelDetectionEnabled: booleanEnv("LABEL_DETECTION_ENABLED", false),
      detectorProjectDir: path.resolve(process.cwd(), optionalEnv("LABEL_DETECTOR_PROJECT_DIR", "../llc-inventory/label-detector")),
      detectorPython: resolveOptionalPath(optionalEnv("LABEL_DETECTOR_PYTHON")) || "python",
      detectorWeightsPath: resolveOptionalPath(optionalEnv("LABEL_DETECTOR_WEIGHTS_PATH")),
      detectorDevice: optionalEnv("LABEL_DETECTOR_DEVICE", "cpu"),
      detectorImageSize: numberEnv("LABEL_DETECTOR_IMGSZ", 1280),
      detectorConfidence: Number(optionalEnv("LABEL_DETECTOR_CONF", "0.2")) || 0.2
    },
    collectrProxy: {
      enabled: booleanEnv("COLLECTR_PROXY_ENABLED", false),
      host: optionalEnv("COLLECTR_PROXY_HOST", "127.0.0.1"),
      port: numberEnv("COLLECTR_PROXY_PORT", 8788),
      secret: requireWhenEnabled("COLLECTR_PROXY_SECRET", booleanEnv("COLLECTR_PROXY_ENABLED", false)),
      accountId: requireWhenEnabled("COLLECTR_ACCOUNT_ID", booleanEnv("COLLECTR_PROXY_ENABLED", false)),
      authToken: requireWhenEnabled("COLLECTR_AUTH_TOKEN", booleanEnv("COLLECTR_PROXY_ENABLED", false)),
      apiBaseUrl: optionalEnv("COLLECTR_API_BASE_URL", "https://api-v2.getcollectr.com"),
      requestTimeoutMs: numberEnv("COLLECTR_PROXY_REQUEST_TIMEOUT_MS", 30000)
    }
  };
}

module.exports = {
  loadConfig
};
