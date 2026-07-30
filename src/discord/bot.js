const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  MessageFlags
} = require("discord.js");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { ImageAnalysisService } = require("../imageAnalysis/imageAnalysisService");
const { buildCaptureScans } = require("../capture/scanBuilder");
const { buildUploadName, uploadBufferToImgbb } = require("../imageUpload/imgbb");

const STATUS_REACTIONS = {
  pending: "\u23f3",
  success: "\u2705",
  warning: "\u26a0\ufe0f",
  failure: "\u274c"
};

const CAPTURE_COMMAND_NAME = "capture";

function getCountReaction(count) {
  const numberReactions = {
    1: "1\ufe0f\u20e3",
    2: "2\ufe0f\u20e3",
    3: "3\ufe0f\u20e3",
    4: "4\ufe0f\u20e3",
    5: "5\ufe0f\u20e3",
    6: "6\ufe0f\u20e3",
    7: "7\ufe0f\u20e3",
    8: "8\ufe0f\u20e3",
    9: "9\ufe0f\u20e3",
    10: "\ud83d\udd1f"
  };
  return numberReactions[count] || "\ud83d\udd22";
}

async function removeBotReaction(message, emoji) {
  if (!message || !message.reactions || !message.reactions.cache || !message.client || !message.client.user) {
    return;
  }
  const reaction = message.reactions.cache.find((entry) => {
    const key = entry.emoji && (entry.emoji.id || entry.emoji.name);
    return key === emoji;
  });
  if (reaction) {
    await reaction.users.remove(message.client.user.id).catch(() => {});
  }
}

function buildCommands() {
  const captureCommand = new SlashCommandBuilder()
    .setName(CAPTURE_COMMAND_NAME)
    .setDescription("Control inventory capture sessions.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Create and start a new capture thread under an organizer channel.")
        .addStringOption((option) =>
          option
            .setName("organizer")
            .setDescription("Organizer key.")
            .setRequired(true)
            .addChoices(
              { name: "Nace", value: "nace" },
              { name: "Cardfesta", value: "cardfesta" },
              { name: "Other", value: "other" }
            )
        )
        .addStringOption((option) =>
          option
            .setName("session_name")
            .setDescription("Optional session name.")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stop")
        .setDescription("Stop the active capture session.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show the active capture session and thread status.")
    );
  return [captureCommand.toJSON()];
}

async function replaceGuildCommands(guild, commands) {
  await guild.commands.set(commands);
}

async function startDiscordBot({ config, logger, captureService }) {
  if (!config.discordEnabled) {
    logger.info("DISCORD_ENABLED=false; Discord bot connection is disabled.");
    return null;
  }

  const imageAnalysisService = new ImageAnalysisService({
    config: config.imageAnalysis,
    logger
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  client.on("clientReady", async () => {
    logger.info({ guildId: config.discord.guildId }, "Discord v2 bot connected.");
    if (captureService.discordAdapter && typeof captureService.discordAdapter.setClient === "function") {
      captureService.discordAdapter.setClient(client);
    }
    if (config.discord.guildId) {
      const guild = await client.guilds.fetch(config.discord.guildId);
      await replaceGuildCommands(guild, buildCommands());
      logger.info("Registered Discord commands.");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isChatInputCommand || !interaction.isChatInputCommand()) {
        return;
      }
      if (interaction.commandName !== CAPTURE_COMMAND_NAME) {
        return;
      }
      if (config.discord.commandsChannelId && interaction.channelId !== config.discord.commandsChannelId) {
        await interaction.reply({
          content: "Use `/capture` in the configured commands channel.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "start") {
        const result = captureService.requestStart({
          organizerKey: interaction.options.getString("organizer", true),
          sessionName: interaction.options.getString("session_name", false) || "Session",
          requestedBy: interaction.user.username || interaction.user.id
        });
        await interaction.reply({
          content: [
            "Capture start queued.",
            "Session ID: `" + result.session.id + "`",
            "Job ID: `" + result.job.id + "`",
            "State: `" + result.session.state + "`"
          ].join("\n"),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (subcommand === "stop") {
        const result = captureService.requestStopLatest({
          requestedBy: interaction.user.username || interaction.user.id
        });
        await interaction.reply({
          content: [
            "Capture stop queued.",
            "Session ID: `" + result.session.id + "`",
            "Job ID: `" + result.job.id + "`",
            "State: `" + result.session.state + "`"
          ].join("\n"),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (subcommand === "status") {
        const status = captureService.getStatus();
        const session = status.activeSession;
        const sessionLines = session
          ? [
              "Active/working session: `" + session.id + "`",
              "State: `" + session.state + "`",
              "Thread: " + (session.discordThreadId ? "`" + session.discordThreadId + "`" : "not created"),
              "Sheet tab: `" + (session.appsScriptSession.sheet_tab_name || "not started") + "`"
            ]
          : ["No active or working capture session."];
        await interaction.reply({
          content: sessionLines.concat([
            "Recent jobs: " + status.recentJobs.length
          ]).join("\n"),
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error({ err: error }, "Discord interaction failed.");
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Capture command failed: " + error.message,
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    }
  });

  client.on("messageCreate", async (message) => {
    try {
      await handleCaptureThreadMessage({
        message,
        captureService,
        imageAnalysisService,
        imageUploadConfig: config.imageUpload,
        logger
      });
    } catch (error) {
      logger.error({ err: error, messageId: message && message.id }, "Capture thread message handling failed.");
      if (message && typeof message.react === "function") {
        await message.react(STATUS_REACTIONS.failure).catch(() => {});
      }
    }
  });

  await client.login(config.discord.botToken);
  return client;
}

function isImageAttachment(attachment) {
  const contentType = String(attachment.contentType || "").toLowerCase();
  if (contentType.startsWith("image/")) {
    return true;
  }
  return [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(attachment.name || "").toLowerCase());
}

async function downloadBuffer(url, fallbackUrl) {
  const urls = [url, fallbackUrl].filter(Boolean);
  let lastError = null;
  for (const candidate of urls) {
    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No attachment URL available.");
}

function getImageExtension(attachment) {
  const ext = path.extname(String(attachment.name || "")).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
    return ext;
  }
  const contentType = String(attachment.contentType || "").toLowerCase();
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  return ".jpg";
}

async function withTemporaryImageFile(buffer, extension, callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llc-inventory-v2-image-"));
  const filePath = path.join(dir, randomUUID() + extension);
  await fs.writeFile(filePath, buffer);
  try {
    return await callback(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleCaptureThreadMessage({ message, captureService, imageAnalysisService, imageUploadConfig = {}, logger }) {
  if (!message || !message.channelId || (message.author && message.author.bot)) {
    return false;
  }

  const session = captureService.getActiveSessionForThread(message.channelId);
  if (!session) {
    return false;
  }

  const imageAttachments = message.attachments
    ? Array.from(message.attachments.values()).filter(isImageAttachment)
    : [];
  if (!imageAttachments.length) {
    return false;
  }

  await message.react(STATUS_REACTIONS.pending).catch(() => {});
  let totalQrCount = 0;
  let wroteRows = 0;

  for (const [attachmentIndex, attachment] of imageAttachments.entries()) {
    const buffer = await downloadBuffer(attachment.proxyURL || attachment.url, attachment.url);
    let imageUrl = "";
    let imageUploadError = "";
    try {
      const uploadName = buildUploadName(
        imageAttachments.length > 1 ? message.id + "-" + attachmentIndex : message.id,
        new Date(message.createdTimestamp || Date.now())
      );
      const upload = await uploadBufferToImgbb(buffer, imageUploadConfig.imgbbApiKey, uploadName);
      imageUrl = upload.url || "";
      imageUploadError = upload.error || "";
    } catch (error) {
      imageUploadError = "imgbb: " + error.message;
    }

    const analysis = await withTemporaryImageFile(buffer, getImageExtension(attachment), (imagePath) =>
      imageAnalysisService.analyzeBuffer(buffer, { imagePath })
    );
    const scans = buildCaptureScans({
      qrValues: analysis.qrValues,
      messageId: message.id,
      attachmentIndex,
      analysis
    });
    totalQrCount += analysis.qrValues.length;

    const result = await captureService.appsScriptClient.appendCaptureScans({
      sessionId: session.appsScriptSession.session_id,
      threadId: session.discordThreadId,
      senderId: message.author ? message.author.id : "",
      senderName: message.author ? message.author.username : "",
      messageId: imageAttachments.length > 1 ? message.id + ":" + attachmentIndex : message.id,
      imageFileName: attachment.name || "",
      imageUrl,
      caption: message.content || "",
      sourceTimestampMs: message.createdTimestamp || Date.now(),
      scans: imageUploadError
        ? scans.map((scan) => ({
            ...scan,
            parseError: [scan.parseError, imageUploadError].filter(Boolean).join(" | ")
          }))
        : scans
    });
    wroteRows += Number(result.result && result.result.appended || 0) + Number(result.result && result.result.updated || 0);
  }

  await removeBotReaction(message, STATUS_REACTIONS.pending);
  if (totalQrCount > 0) {
    await message.react(STATUS_REACTIONS.success).catch(() => {});
    await message.react(getCountReaction(totalQrCount)).catch(() => {});
    if (totalQrCount > 10) {
      await message.reply("Detected QR count: " + totalQrCount + ".").catch(() => {});
    }
  } else {
    await message.react(STATUS_REACTIONS.warning).catch(() => {});
  }
  logger.info({
    messageId: message.id,
    threadId: message.channelId,
    totalQrCount,
    wroteRows
  }, "Processed capture image message.");
  return true;
}

module.exports = {
  startDiscordBot,
  buildCommands,
  replaceGuildCommands,
  handleCaptureThreadMessage,
  isImageAttachment,
  getCountReaction
};
