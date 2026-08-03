const http = require("http");
const { buildCollectrUrl, fetchCollectrJson, isAllowedCollectrPath } = require("./client");
const { AuditCollectrReviewService } = require("./auditReviewService");

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

function startCollectrProxyServer({ config, logger, store }) {
  if (!config.collectrProxy.enabled) {
    return null;
  }

  const auditReviewService = store
    ? new AuditCollectrReviewService({ config: config.collectrProxy, store, logger })
    : null;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (!safeEqual(request.headers["x-collectr-proxy-secret"], config.collectrProxy.secret)) {
      sendJson(response, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    if (auditReviewService && url.pathname === "/collectr/audit-review/status") {
      if (request.method !== "GET") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." });
        return;
      }
      try {
        sendJson(response, 200, { ok: true, job: auditReviewService.getJob(url.searchParams.get("jobId")) });
      } catch (error) {
        sendJson(response, 404, { ok: false, error: error.message });
      }
      return;
    }

    if (auditReviewService && url.pathname === "/collectr/audit-review/start") {
      if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." });
        return;
      }
      try {
        const body = await readJsonBody(request, 2 * 1024 * 1024);
        sendJson(response, 200, { ok: true, job: auditReviewService.startJob(body) });
      } catch (error) {
        logger.warn({ err: error }, "Collectr audit review start failed.");
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (auditReviewService && url.pathname === "/collectr/audit-review/stop") {
      if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." });
        return;
      }
      try {
        const body = await readJsonBody(request);
        sendJson(response, 200, { ok: true, job: auditReviewService.stopJob(body.jobId) });
      } catch (error) {
        sendJson(response, 404, { ok: false, error: error.message });
      }
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

    let body = {};
    let method = "GET";
    try {
      body = await readJsonBody(request);
      method = String(body.method || "GET").trim().toUpperCase();
      if (["GET", "POST", "PUT"].indexOf(method) === -1) {
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
        purchasePriceCount: body.body && Array.isArray(body.body.data) ? body.body.data.length : undefined,
        subType: body.body && body.body.subType,
        gradeId: body.body && body.body.gradeId
        }, "Collectr proxy write succeeded.");
      }
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      logger.warn({
        err: error,
        method,
        path: body.path,
        collectionId: body.query && body.query.collectionId,
        quantity: body.body && body.body.quantity,
        purchasePriceCount: body.body && Array.isArray(body.body.data) ? body.body.data.length : undefined,
        subType: body.body && body.body.subType,
        gradeId: body.body && body.body.gradeId,
        upstreamStatus: error.status
      }, "Collectr proxy request failed.");
      sendJson(response, error.status || 502, {
        ok: false,
        error: error.message,
        upstreamStatus: error.status
      });
    }
  });

  server.listen(config.collectrProxy.port, config.collectrProxy.host, () => {
    logger.info({
      host: config.collectrProxy.host,
      port: config.collectrProxy.port
    }, "Collectr proxy server listening.");
  });

  if (auditReviewService) {
    auditReviewService.start();
    server.on("close", () => auditReviewService.stop());
  }

  return server;
}

module.exports = {
  buildCollectrUrl,
  fetchCollectrJson,
  isAllowedCollectrPath,
  safeEqual,
  startCollectrProxyServer
};
