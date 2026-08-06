const http = require("http");
const dotenv = require("dotenv");
const pino = require("pino");
const { fetchCollectrJson, isAllowedCollectrPath } = require("./client");
const { safeEqual } = require("./proxyServer");

dotenv.config();

function optionalEnv(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : String(value).trim();
}

function numberEnv(name, fallback) {
  const value = Number(optionalEnv(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
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

function loadRelayConfig() {
  return {
    host: optionalEnv("LOCAL_COLLECTR_RELAY_HOST", "127.0.0.1"),
    port: numberEnv("LOCAL_COLLECTR_RELAY_PORT", 8790),
    secret: optionalEnv("LOCAL_COLLECTR_RELAY_SECRET") || optionalEnv("COLLECTR_RELAY_SECRET") || optionalEnv("COLLECTR_PROXY_SECRET"),
    requestDelayMs: numberEnv("LOCAL_COLLECTR_RELAY_DELAY_MS", 3000),
    collectr: {
      authToken: optionalEnv("COLLECTR_AUTH_TOKEN"),
      apiBaseUrl: optionalEnv("COLLECTR_API_BASE_URL", "https://api-v2.getcollectr.com"),
      requestTimeoutMs: numberEnv("COLLECTR_PROXY_REQUEST_TIMEOUT_MS", 30000)
    }
  };
}

function createRequestQueue(delayMs) {
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  return function enqueue(task) {
    const next = queue.catch(() => {}).then(async () => {
      const waitMs = Math.max(0, lastRequestAt + delayMs - Date.now());
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      try {
        return await task();
      } finally {
        lastRequestAt = Date.now();
      }
    });
    queue = next.then(() => {}, () => {});
    return next;
  };
}

function startLocalCollectrRelay({ config, logger }) {
  if (!config.secret) {
    throw new Error("Missing relay secret. Set LOCAL_COLLECTR_RELAY_SECRET or COLLECTR_RELAY_SECRET.");
  }
  if (!config.collectr.authToken) {
    throw new Error("Missing Collectr token. Set COLLECTR_AUTH_TOKEN.");
  }
  const enqueueCollectrRequest = createRequestQueue(config.requestDelayMs);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        relay: "local-collectr",
        requestDelayMs: config.requestDelayMs,
        browserHeaders: true
      });
      return;
    }
    if (url.pathname !== "/collectr/relay") {
      sendJson(response, 404, { ok: false, error: "Not found." });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "Method not allowed." });
      return;
    }
    if (!safeEqual(request.headers["x-collectr-relay-secret"], config.secret)) {
      sendJson(response, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    let body = {};
    let method = "GET";
    try {
      body = await readJsonBody(request);
      const path = String(body.path || "").trim();
      method = String(body.method || "GET").trim().toUpperCase();
      if (["GET", "POST", "PUT"].indexOf(method) === -1) {
        throw new Error("Collectr method is not allowed.");
      }
      if (!isAllowedCollectrPath(path)) {
        throw new Error("Collectr path is not allowed.");
      }
      const data = await enqueueCollectrRequest(() => fetchCollectrJson(config.collectr, path, body.query || {}, {
        method,
        body: body.body || {}
      }));
      if (method !== "GET") {
        logger.info({
          method,
          path,
          collectionId: body.query && body.query.collectionId,
          quantity: body.body && body.body.quantity,
          purchasePriceCount: body.body && Array.isArray(body.body.data) ? body.body.data.length : undefined
        }, "Local Collectr relay write succeeded.");
      }
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      logger.warn({
        err: error,
        method,
        path: body.path,
        upstreamStatus: error.status
      }, "Local Collectr relay request failed.");
      sendJson(response, error.status || 502, {
        ok: false,
        error: error.message,
        upstreamStatus: error.status
      });
    }
  });

  server.listen(config.port, config.host, () => {
    logger.info({
      host: config.host,
      port: config.port,
      requestDelayMs: config.requestDelayMs
    }, "Local Collectr relay listening.");
  });

  return server;
}

if (require.main === module) {
  const logger = pino({ level: optionalEnv("LOG_LEVEL", "info") });
  startLocalCollectrRelay({ config: loadRelayConfig(), logger });
}

module.exports = {
  loadRelayConfig,
  startLocalCollectrRelay
};
