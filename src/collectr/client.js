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

async function fetchCollectrJson(config, path, query = {}, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const method = String(options.method || "GET").toUpperCase();
  try {
    const response = await fetch(buildCollectrUrl(config, path, query), {
      method,
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": config.authToken,
        "Origin": "https://app.getcollectr.com",
        "Referer": "https://app.getcollectr.com/"
      },
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
      throw error;
    }
    if (!response.ok) {
      const error = new Error(data.error || data.message || "Collectr request failed with HTTP " + response.status + ".");
      error.status = response.status;
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
  fetchCollectrJson,
  isAllowedCollectrPath
};
