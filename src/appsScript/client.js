class AppsScriptClient {
  constructor({ baseUrl, requestTimeoutMs = 45000 }) {
    this.baseUrl = baseUrl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async post(path, payload) {
    if (!this.baseUrl) {
      throw new Error("Apps Script base URL is not configured.");
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      redirect: "follow",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path, payload })
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error("Apps Script returned invalid JSON for " + path + ".");
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Apps Script request failed for " + path + ".");
    }
    return data;
  }

  startCaptureSession({ threadId, sessionName, startedBy }) {
    return this.post("capture/start", {
      groupId: threadId,
      sessionName,
      startedBy
    });
  }

  stopCaptureSession({ threadId, endedBy }) {
    return this.post("capture/stop", {
      groupId: threadId,
      endedBy
    });
  }

  appendCaptureScans(payload) {
    return this.post("capture/scan", {
      ...payload,
      groupId: payload.threadId || payload.groupId
    });
  }
}

module.exports = {
  AppsScriptClient
};
