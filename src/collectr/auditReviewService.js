const { createHash } = require("crypto");
const { fetchCollectrJson } = require("./client");

const JOB_TYPE = "audit_collectr_review";
const BATCH_DELAY_MS = 1250;
const PORTFOLIO_CACHE_TTL_MS = 10 * 60 * 1000;
const FINGERPRINT_VERSION = 2;

function normalizeValue(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeCardId(cardId) {
  return String(cardId || "").trim().toUpperCase();
}

function fingerprintPayload(sessionId, rows) {
  const source = JSON.stringify({
    version: FINGERPRINT_VERSION,
    sessionId,
    rows: rows.map((row) => ({
      cardId: normalizeCardId(row.cardId),
      scannedCount: Number(row.scannedCount || 0),
      sheetQuantity: Number(row.sheetQuantity || 0)
    })).sort((a, b) => a.cardId.localeCompare(b.cardId))
  });
  return createHash("sha256").update(source).digest("hex");
}

function isForbiddenCollectrError(error) {
  return Number(error && error.status || 0) === 403 || /HTTP 403|forbidden/i.test(String(error && error.message || error || ""));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function selectDataArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function flattenProductDetailLines(data) {
  const product = data && data.data ? data.data : data;
  if (!product || typeof product !== "object") return [];
  const keys = ["ungraded_sub_types", "graded_sub_types", "product_sub_types"];
  const rows = [];
  for (const key of keys) {
    const values = Array.isArray(product[key]) ? product[key] : [];
    for (const value of values) {
      rows.push({
        product_id: value.product_id || product.product_id || product.id,
        product_name: value.product_name || product.product_name || product.name,
        catalog_group: value.catalog_group || product.catalog_group || product.group_name,
        card_number: value.card_number || product.card_number,
        product_sub_type: value.product_sub_type || value.sub_type || value.subType,
        grade_id: value.grade_id || value.gradeId,
        user_owned_product_id: value.user_owned_product_id || value.userOwnedProductId,
        quantity: value.quantity || 0
      });
    }
  }
  return rows;
}

function getSummaryStatus(row) {
  if (!row.item) return "not-in-sheet";
  if (row.collectrError) return row.status === "match" ? "collectr-error" : row.status;
  if (row.unscanned || (Number(row.scannedCount || 0) === 0 && Number(row.sheetQuantity || 0) > 0)) return "unscanned";
  if (row.collectrQuantity === null || row.collectrQuantity === undefined) return row.status;
  if (Number(row.scannedCount || 0) === Number(row.sheetQuantity || 0) &&
      Number(row.scannedCount || 0) === Number(row.collectrQuantity || 0)) {
    return "match";
  }
  if (Number(row.scannedCount || 0) < Number(row.sheetQuantity || 0) ||
      Number(row.scannedCount || 0) < Number(row.collectrQuantity || 0)) {
    return "short";
  }
  return "over";
}

class AuditCollectrReviewService {
  constructor({ config, store, logger }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.portfolioCache = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processNext().catch((error) => {
        this.logger.error({ err: error }, "Collectr audit review loop failed.");
      });
    }, BATCH_DELAY_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  startJob(payload) {
    const sessionId = String(payload.sessionId || "").trim();
    const rows = Array.isArray(payload.rows) ? payload.rows.filter((row) => row && row.item && row.cardId) : [];
    if (!sessionId) throw new Error("Audit session is required.");
    if (!rows.length) throw new Error("At least one review row is required.");

    const fingerprint = fingerprintPayload(sessionId, rows);
    const existing = this.store.listJobs({ type: JOB_TYPE, limit: 200 }).find((job) =>
      job.payload.sessionId === sessionId &&
      job.payload.fingerprint === fingerprint &&
      ["pending", "running", "complete"].includes(job.state)
    );
    if (existing) return this.serializeJob(existing);

    const job = this.store.createJob({
      type: JOB_TYPE,
      state: "pending",
      payload: {
        sessionId,
        fingerprint,
        total: rows.length,
        rows: rows.map((row) => ({
          cardId: row.cardId,
          scannedCount: Number(row.scannedCount || 0),
          sheetQuantity: Number(row.sheetQuantity || 0),
          status: row.status || "",
          item: row.item,
          recordKeys: Array.isArray(row.recordKeys) ? row.recordKeys : []
        }))
      },
      result: {
        sessionId,
        total: rows.length,
        loaded: 0,
        rowsById: {},
        errors: []
      }
    });
    return this.serializeJob(job);
  }

  getJob(jobId) {
    const job = this.store.getJob(String(jobId || "").trim());
    if (!job || job.type !== JOB_TYPE) throw new Error("Collectr review job not found.");
    return this.serializeJob(job);
  }

  stopJob(jobId) {
    const job = this.store.getJob(String(jobId || "").trim());
    if (!job || job.type !== JOB_TYPE) throw new Error("Collectr review job not found.");
    if (job.state === "complete") return this.serializeJob(job);
    return this.serializeJob(this.store.updateJob(job.id, { state: "canceled" }));
  }

  async processNext() {
    if (this.running) return;
    this.running = true;
    try {
      const job = this.store.claimNextJob({
        type: JOB_TYPE,
        states: ["pending", "running"],
        leaseMs: 30000
      });
      if (!job || job.state === "canceled") return;

      const payloadRows = Array.isArray(job.payload.rows) ? job.payload.rows : [];
      const result = job.result || {};
      const rowsById = result.rowsById || {};
      const nextRow = payloadRows.find((row) => !rowsById[normalizeCardId(row.cardId)]);
      if (!nextRow) {
        this.store.updateJob(job.id, {
          state: "complete",
          result: this.withTotals(job.payload, result)
        });
        return;
      }

      let resolvedRow;
      try {
        resolvedRow = await this.enrichRow(nextRow);
      } catch (error) {
        if (isForbiddenCollectrError(error)) {
          const message = "Collectr returned HTTP 403 and blocked the audit review. Stop for now, then try again later or use the local relay/browser path.";
          this.store.updateJob(job.id, {
            state: "failed",
            error: message,
            result: this.withTotals(job.payload, {
              ...result,
              errors: (result.errors || []).concat([{
                cardId: nextRow.cardId,
                error: message,
                collectrPath: error.collectrPath || "",
                collectrMethod: error.collectrMethod || ""
              }]),
              rowsById,
              loaded: Object.keys(rowsById).length
            }),
            lockedUntilMs: 0
          });
          return;
        }
        resolvedRow = {
          ...nextRow,
          collectrQuantity: null,
          collectrDifference: null,
          collectrPortfolioName: "",
          collectrProductId: "",
          collectrWarnings: [],
          collectrLoaded: false,
          collectrPending: false,
          collectrError: error.message,
          status: nextRow.status === "match" ? "collectr-error" : nextRow.status
        };
      }

      rowsById[normalizeCardId(nextRow.cardId)] = resolvedRow;
      const nextResult = this.withTotals(job.payload, {
        ...result,
        rowsById,
        loaded: Object.keys(rowsById).length
      });
      this.store.updateJob(job.id, {
        state: Object.keys(rowsById).length >= payloadRows.length ? "complete" : "running",
        result: nextResult,
        lockedUntilMs: 0
      });
    } finally {
      this.running = false;
    }
  }

  withTotals(payload, result) {
    const rowsById = result.rowsById || {};
    const rows = Object.values(rowsById);
    const totals = rows.reduce((output, row) => {
      output.collectrQuantity += row.collectrLoaded && !row.collectrError ? Number(row.collectrQuantity || 0) : 0;
      output.issueCount += row.status === "match" ? 0 : 1;
      return output;
    }, { collectrQuantity: 0, issueCount: 0 });
    return {
      ...result,
      sessionId: payload.sessionId,
      total: payload.total,
      loaded: Object.keys(rowsById).length,
      totals
    };
  }

  async enrichRow(row) {
    const resolved = await this.resolveCollectrItem(row.item);
    const next = {
      ...row,
      collectrQuantity: resolved.collectr.currentQuantity,
      collectrDifference: Number(row.scannedCount || 0) - Number(resolved.collectr.currentQuantity || 0),
      collectrPortfolioName: resolved.portfolio.name,
      collectrProductId: resolved.product.id,
      collectrSubType: resolved.product.subType,
      collectrGradeId: resolved.product.gradeId,
      collectrUserOwnedProductId: resolved.product.userOwnedProductId,
      collectrWarnings: resolved.warnings,
      collectrLoaded: true,
      collectrPending: false
    };
    next.status = getSummaryStatus(next);
    return next;
  }

  async getPortfolios() {
    const now = Date.now();
    if (this.portfolioCache && this.portfolioCache.expiresAt > now) {
      return cloneJson(this.portfolioCache.data);
    }
    const data = await fetchCollectrJson(this.config, "/accounts/" + encodeURIComponent(this.config.accountId) + "/collections");
    const portfolios = selectDataArray(data);
    this.portfolioCache = {
      data: portfolios,
      expiresAt: now + PORTFOLIO_CACHE_TTL_MS
    };
    return cloneJson(portfolios);
  }

  async resolvePortfolio(item) {
    const directId = String(item.collectrCollectionId || item.collectrPortfolioId || "").trim();
    const portfolios = await this.getPortfolios();
    if (directId) {
      const match = portfolios.find((portfolio) => String(portfolio.id || portfolio.collection_id || "").trim() === directId);
      if (match) return { portfolio: match, warnings: [] };
    }
    const expected = normalizeValue(item.portfolioName);
    const matches = portfolios.filter((portfolio) => normalizeValue(portfolio.name || portfolio.collection_name) === expected);
    if (matches.length === 1) return { portfolio: matches[0], warnings: [] };
    if (!matches.length) throw new Error("Collectr portfolio not found for " + (item.portfolioName || "item") + ".");
    return { portfolio: matches[0], warnings: ["Multiple Collectr portfolios matched; using first match."] };
  }

  async resolveProduct(item, portfolio) {
    const directId = String(item.collectrProductId || "").trim();
    const subtype = item.collectrSubType || item.variance || "";
    const expectedSet = normalizeValue(item.setName);
    const expectedName = normalizeValue(item.name);
    const expectedNumber = normalizeValue(item.cardNumber);
    const expectedSubtype = normalizeValue(subtype);
    const collectionId = portfolio.id || portfolio.collection_id;
    if (directId) {
      const ownedRows = selectDataArray(await fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products", {
        collectionId,
        productIds: directId,
        unstackedView: true,
        currency: "CAD"
      }));
      const selected = ownedRows.find((line) => !expectedSubtype || normalizeValue(line.product_sub_type) === expectedSubtype) || ownedRows[0] || {};
      return {
        product: {
          id: directId,
          subType: selected.product_sub_type || subtype,
          gradeId: selected.grade_id || item.collectrGradeId || "",
          userOwnedProductId: selected.user_owned_product_id || "",
          quantity: selected.quantity || 0
        },
        warnings: []
      };
    }
    const ownedRows = selectDataArray(await fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products", {
      collectionId,
      unstackedView: true,
      currency: "CAD",
      limit: 1000
    }));
    const matches = ownedRows.filter((product) =>
      normalizeValue(product.catalog_group || product.set_name || product.group_name) === expectedSet &&
      normalizeValue(product.product_name || product.name) === expectedName &&
      normalizeValue(product.card_number || product.number) === expectedNumber &&
      (!expectedSubtype || normalizeValue(product.product_sub_type || product.sub_type || product.subType) === expectedSubtype)
    );
    const product = matches[0];
    if (!product) throw new Error("Collectr product not found for " + (item.name || item.cardId) + ".");
    const productId = String(product.product_id || product.id || "").trim();
    if (!productId) throw new Error("Collectr product match did not include an ID.");
    const detailRows = flattenProductDetailLines(await fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products/" + encodeURIComponent(productId), {
      collectionId,
      currency: "CAD",
      details: "false"
    }));
    const lines = detailRows.length ? detailRows : matches;
    const selected = lines.find((line) => !expectedSubtype || normalizeValue(line.product_sub_type) === expectedSubtype) || lines[0] || {};
    return {
      product: {
        id: productId,
        subType: selected.product_sub_type || product.product_sub_type || subtype,
        gradeId: selected.grade_id || item.collectrGradeId || "",
        userOwnedProductId: selected.user_owned_product_id || "",
        quantity: selected.quantity || 0
      },
      warnings: matches.length > 1 ? ["Multiple Collectr products matched; using first match."] : []
    };
  }

  async resolveCollectrItem(item) {
    const portfolioResolution = await this.resolvePortfolio(item);
    const productResolution = await this.resolveProduct(item, portfolioResolution.portfolio);
    return {
      portfolio: {
        id: portfolioResolution.portfolio.id || portfolioResolution.portfolio.collection_id,
        name: portfolioResolution.portfolio.name || portfolioResolution.portfolio.collection_name || ""
      },
      product: productResolution.product,
      collectr: {
        currentQuantity: Number(productResolution.product.quantity || 0)
      },
      warnings: portfolioResolution.warnings.concat(productResolution.warnings)
    };
  }

  serializeJob(job) {
    const result = job.result || {};
    return {
      id: job.id,
      state: job.state,
      sessionId: job.payload.sessionId || result.sessionId || "",
      total: Number(result.total || job.payload.total || 0),
      loaded: Number(result.loaded || 0),
      rows: Object.values(result.rowsById || {}),
      totals: result.totals || { collectrQuantity: 0, issueCount: 0 },
      error: job.error || "",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }
}

module.exports = {
  AuditCollectrReviewService,
  JOB_TYPE,
  flattenProductDetailLines,
  normalizeCardId,
  normalizeValue,
  selectDataArray
};
