class DryRunDiscordAdapter {
  async createCaptureThread({ organizerKey, sessionName }) {
    const suffix = String(sessionName || "Session").replace(/[^A-Za-z0-9._-]/g, "-");
    return {
      id: "dry-thread-" + String(organizerKey || "organizer") + "-" + Date.now(),
      name: "Dry Run - " + suffix
    };
  }
}

class DiscordThreadAdapter {
  constructor({ config }) {
    this.config = config;
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  async createCaptureThread({ organizerKey, sessionName, requestedBy }) {
    if (!this.client) {
      throw new Error("Discord client is not connected.");
    }
    const parentChannelId = this.config.discord.organizerChannels[organizerKey];
    if (!parentChannelId) {
      throw new Error("Unknown organizer channel: " + organizerKey);
    }
    const parent = await this.client.channels.fetch(parentChannelId);
    if (!parent || !parent.threads || typeof parent.threads.create !== "function") {
      throw new Error("Organizer channel cannot create threads: " + organizerKey);
    }
    const dateKey = new Date().toISOString().slice(0, 10);
    const cleanName = String(sessionName || "Session").trim() || "Session";
    return parent.threads.create({
      name: dateKey + " - " + cleanName,
      autoArchiveDuration: 10080,
      reason: "Inventory capture v2 requested by " + String(requestedBy || "unknown")
    });
  }
}

module.exports = {
  DryRunDiscordAdapter,
  DiscordThreadAdapter
};
