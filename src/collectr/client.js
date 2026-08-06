const ALLOWED_COLLECTR_PATHS = [
  /^\/accounts\/[^/]+\/collections$/,
  /^\/collections\/[^/]+\/products$/,
  /^\/collections\/[^/]+\/products\/[^/]+$/,
  /^\/collections\/[^/]+\/products\/owned\/[^/]+\/purchase-prices$/,
  /^\/catalog$/
];

function isAllowedCollectrPath(path) {
  return ALLOWED_COLLECTR_PATHS.some((pattern) => pattern.test(path));
}

function buildCollectrUrl(config, path, query = {}) {
  const normalizedPath = String(path || "").trim();
  if (!isAllowedCollectrPath(normalizedPath)) {
    throw new Error("Collectr path is not allowed.");
  }

  const url = new URL(normalizedPath, config.apiBaseUrl);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url;
}

function buildRelayUrl(config) {
  const base = String(config.relayBaseUrl || "").trim();
  if (!base) return null;
  const normalizedBase = base.endsWith("/") ? base : base + "/";
  return new URL("collectr/relay", normalizedBase);
}

function buildCollectrHeaders(config) {
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://app.getcollectr.com",
    "Referer": "https://app.getcollectr.com/",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-CH-UA": "\"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Google Chrome\";v=\"150\"",
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": "\"Windows\"",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
  };
  if (config.authToken) {
    headers.Authorization = config.authToken;
  }
  return headers;
}

async function fetchRelayJson(config, path, query = {}, options = {}) {
  const relayUrl = buildRelayUrl(config);
  if (!relayUrl) return null;
  if (!isAllowedCollectrPath(String(path || "").trim())) {
    throw new Error("Collectr path is not allowed.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const method = String(options.method || "GET").toUpperCase();
  try {
    const response = await fetch(relayUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Collectr-Relay-Secret": config.relaySecret || ""
      },
      body: JSON.stringify({
        path,
        query,
        method,
        body: options.body || {}
      })
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text || "{}");
    } catch (_) {
      const error = new Error(
        "Collectr relay returned non-JSON: HTTP " + response.status +
        ", content-type " + (response.headers.get("content-type") || "unknown")
      );
      error.status = response.status;
      throw error;
    }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || "Collectr relay request failed with HTTP " + response.status + ".");
      error.status = data.upstreamStatus || response.status;
      error.collectrPath = path;
      error.collectrMethod = method;
      error.response = data;
      throw error;
    }
    return data.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCollectrJson(config, path, query = {}, options = {}) {
  if (buildRelayUrl(config)) {
    return fetchRelayJson(config, path, query, options);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const method = String(options.method || "GET").toUpperCase();
  try {
    const response = await fetch(buildCollectrUrl(config, path, query), {
      method,
      signal: controller.signal,
      headers: buildCollectrHeaders(config),
      body: method === "GET" ? undefined : JSON.stringify(options.body || {})
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text || "{}");
    } catch (_) {
      const error = new Error(
        "Collectr returned non-JSON: HTTP " + response.status +
        ", content-type " + (response.headers.get("content-type") || "unknown")
      );
      error.status = response.status;
      error.collectrPath = path;
      error.collectrMethod = method;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(data.error || data.message || "Collectr request failed with HTTP " + response.status + ".");
      error.status = response.status;
      error.collectrPath = path;
      error.collectrMethod = method;
      error.response = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  buildCollectrUrl,
  buildCollectrHeaders,
  fetchCollectrJson,
  isAllowedCollectrPath
};
