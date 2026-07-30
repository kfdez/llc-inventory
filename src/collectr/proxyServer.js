const http = require("http");

const ALLOWED_COLLECTR_PATHS = [
  /^\/accounts\/[^/]+\/collections$/,
  /^\/collections\/[^/]+\/products$/,
  /^\/collections\/[^/]+\/products\/[^/]+$/,
  /^\/catalog$/
];

function normalizeSecret(value) {
  return String(value || "").trim();
}

function safeEqual(a, b) {
  const left = normalizeSecret(a);
  const right = normalizeSecret(b);
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function readJsonBody(request, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limitBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error("Invalid JSON request body."));
      }
    });
    request.on("error", reject);
  });
}

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
      throw new Error(
        "Collectr returned non-JSON: HTTP " + response.status +
        ", content-type " + (response.headers.get("content-type") || "unknown")
      );
    }
    if (!response.ok) {
      throw new Error(data.error || data.message || "Collectr request failed with HTTP " + response.status + ".");
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function startCollectrProxyServer({ config, logger }) {
  if (!config.collectrProxy.enabled) {
    return null;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname !== "/collectr/api") {
      sendJson(response, 404, { ok: false, error: "Not found." });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "Method not allowed." });
      return;
    }
    if (!safeEqual(request.headers["x-collectr-proxy-secret"], config.collectrProxy.secret)) {
      sendJson(response, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const method = String(body.method || "GET").trim().toUpperCase();
      if (["GET", "POST"].indexOf(method) === -1) {
        throw new Error("Collectr method is not allowed.");
      }
      const data = await fetchCollectrJson(config.collectrProxy, body.path, body.query || {}, {
        method,
        body: body.body || {}
      });
      if (method !== "GET") {
        logger.info({
          method,
          path: body.path,
          collectionId: body.query && body.query.collectionId,
          quantity: body.body && body.body.quantity,
          subType: body.body && body.body.subType,
          gradeId: body.body && body.body.gradeId
        }, "Collectr proxy write succeeded.");
      }
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      logger.warn({ err: error }, "Collectr proxy request failed.");
      sendJson(response, 502, { ok: false, error: error.message });
    }
  });

  server.listen(config.collectrProxy.port, config.collectrProxy.host, () => {
    logger.info({
      host: config.collectrProxy.host,
      port: config.collectrProxy.port
    }, "Collectr proxy server listening.");
  });

  return server;
}

module.exports = {
  buildCollectrUrl,
  fetchCollectrJson,
  isAllowedCollectrPath,
  safeEqual,
  startCollectrProxyServer
};
