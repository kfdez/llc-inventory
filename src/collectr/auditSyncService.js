const { createHash } = require("crypto");
const { fetchCollectrJson } = require("./client");
const {
  buildCatalogSearchString,
  findUniqueCatalogProduct,
  flattenProductDetailLines,
  normalizeCardId,
  normalizeValue,
  selectDataArray
} = require("./auditReviewService");

const JOB_TYPE = "audit_collectr_sync";
const BATCH_DELAY_MS = 5000;
const MAX_ROW_ATTEMPTS = 3;
const UNGRADED_GRADE_ID = "52";
const FINGERPRINT_VERSION = 1;

function fingerprintPayload(sessionId, rows) {
  const source = JSON.stringify({
    version: FINGERPRINT_VERSION,
    sessionId,
    rows: rows.map((row) => ({
      cardId: normalizeCardId(row.cardId),
      targetQuantity: Number(row.targetQuantity || row.scannedCount || 0),
      productId: row.collectrProductId || row.item && row.item.collectrProductId || "",
      portfolioName: row.collectrPortfolioName || row.item && row.item.portfolioName || ""
    })).sort((a, b) => a.cardId.localeCompare(b.cardId))
  });
  return createHash("sha256").update(source).digest("hex");
}

function isPurchasePriceQuantityError(error) {
  return /quantity in purchase price exceeds quantity in product owned/i.test(String(error && error.message || error || ""));
}

function normalizePurchasePriceRow(row) {
  return {
    id: String(row.id || "").trim(),
    quantity: Number(row.quantity || 0),
    purchase_date: row.purchase_date || null,
    purchase_price: row.purchase_price === undefined ? null : row.purchase_price,
    note: row.note || "",
    card_condition_id: row.card_condition_id || null,
    vault_service_id: row.vault_service_id || null
  };
}

function trimPurchasePriceRows(rows, targetQuantity) {
  let remaining = targetQuantity;
  const output = [];
  for (const row of rows.slice().reverse()) {
    if (remaining <= 0) break;
    const normalized = normalizePurchasePriceRow(row);
    if (!normalized.id || normalized.quantity <= 0) continue;
    const quantity = Math.min(normalized.quantity, remaining);
    output.unshift({ ...normalized, quantity });
    remaining -= quantity;
  }
  return output;
}

class AuditCollectrSyncService {
  constructor({ config, store, logger }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processNext().catch((error) => {
        this.logger.error({ err: error }, "Collectr audit sync loop failed.");
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
    const rows = Array.isArray(payload.rows)
      ? payload.rows.filter((row) => row && row.cardId && Number.isInteger(Number(row.targetQuantity ?? row.scannedCount)))
      : [];
    if (!sessionId) throw new Error("Audit session is required.");
    if (!rows.length) throw new Error("At least one sync row is required.");

    const normalizedRows = rows.map((row) => ({
      cardId: row.cardId,
      targetQuantity: Number(row.targetQuantity ?? row.scannedCount ?? 0),
      sheetQuantity: Number(row.sheetQuantity || 0),
      collectrQuantity: Number(row.collectrQuantity || 0),
      collectrPortfolioName: row.collectrPortfolioName || "",
      collectrProductId: row.collectrProductId || "",
      collectrSubType: row.collectrSubType || "",
      collectrGradeId: row.collectrGradeId || "",
      collectrUserOwnedProductId: row.collectrUserOwnedProductId || "",
      item: row.item || {}
    }));
    this.cancelActiveJobs();
    const fingerprint = fingerprintPayload(sessionId, normalizedRows);

    return this.serializeJob(this.store.createJob({
      type: JOB_TYPE,
      state: "pending",
      payload: {
        sessionId,
        fingerprint,
        total: normalizedRows.length,
        rows: normalizedRows
      },
      result: {
        sessionId,
        total: normalizedRows.length,
        completed: 0,
        failed: 0,
        rowsById: {}
      }
    }));
  }

  cancelActiveJobs() {
    this.store.listJobs({ type: JOB_TYPE, limit: 500 }).forEach((job) => {
      if (["pending", "running"].includes(job.state)) {
        this.store.updateJob(job.id, {
          state: "canceled",
          lockedUntilMs: 0
        });
      }
    });
  }

  getJob(jobId) {
    const job = this.store.getJob(String(jobId || "").trim());
    if (!job || job.type !== JOB_TYPE) throw new Error("Collectr sync job not found.");
    return this.serializeJob(job);
  }

  stopJob(jobId) {
    const job = this.store.getJob(String(jobId || "").trim());
    if (!job || job.type !== JOB_TYPE) throw new Error("Collectr sync job not found.");
    if (["complete", "failed", "canceled"].includes(job.state)) return this.serializeJob(job);
    return this.serializeJob(this.store.updateJob(job.id, { state: "canceled" }));
  }

  async processNext() {
    if (this.running) return;
    this.running = true;
    try {
      const job = this.store.claimNextJob({
        type: JOB_TYPE,
        states: ["pending", "running"],
        leaseMs: 45000
      });
      if (!job) return;
      if (job.state === "canceled") return;

      const payloadRows = Array.isArray(job.payload.rows) ? job.payload.rows : [];
      const result = job.result || {};
      const rowsById = result.rowsById || {};
      const nextRow = payloadRows.find((row) => {
        const saved = rowsById[normalizeCardId(row.cardId)];
        return !saved || saved.status === "retry";
      });
      if (!nextRow) {
        this.store.updateJob(job.id, {
          state: "complete",
          result: this.withTotals(job.payload, result)
        });
        return;
      }

      const cardKey = normalizeCardId(nextRow.cardId);
      const existing = rowsById[cardKey] || {};
      const attempt = Number(existing.attempts || 0) + 1;
      try {
        const synced = await this.syncRow(nextRow);
        rowsById[cardKey] = {
          ...nextRow,
          ...synced,
          status: "synced",
          attempts: attempt,
          error: ""
        };
      } catch (error) {
        const finalFailure = attempt >= MAX_ROW_ATTEMPTS;
        rowsById[cardKey] = {
          ...nextRow,
          status: finalFailure ? "failed" : "retry",
          attempts: attempt,
          error: error.message,
          upstreamStatus: error.status || "",
          collectrPath: error.collectrPath || "",
          collectrMethod: error.collectrMethod || ""
        };
      }

      const nextResult = this.withTotals(job.payload, {
        ...result,
        rowsById
      });
      const terminalRows = Object.values(rowsById).filter((row) => row.status === "synced" || row.status === "failed").length;
      this.store.updateJob(job.id, {
        state: terminalRows >= payloadRows.length ? "complete" : "running",
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
    return {
      ...result,
      sessionId: payload.sessionId,
      total: payload.total,
      completed: rows.filter((row) => row.status === "synced").length,
      failed: rows.filter((row) => row.status === "failed").length,
      rowsById
    };
  }

  async syncRow(row) {
    const resolved = await this.resolveRow(row);
    const targetQuantity = Number(row.targetQuantity || 0);
    const body = {
      subType: resolved.product.subType,
      gradeId: resolved.product.gradeId,
      quantity: targetQuantity
    };
    if (!body.subType) throw new Error("Collectr subtype is required for " + row.cardId + ".");
    if (!body.gradeId) throw new Error("Collectr grade ID is required for " + row.cardId + ".");

    let purchasePriceAdjustment = null;
    try {
      await this.postQuantity(resolved, body);
    } catch (error) {
      if (!isPurchasePriceQuantityError(error) || !resolved.product.userOwnedProductId) throw error;
      purchasePriceAdjustment = await this.trimPurchasePrices(resolved.product.userOwnedProductId, targetQuantity);
      await this.postQuantity(resolved, body);
    }
    const verifiedQuantity = await this.verifyQuantity(resolved, body);
    return {
      collectrQuantity: verifiedQuantity,
      collectrDifference: targetQuantity - verifiedQuantity,
      collectrPortfolioName: resolved.portfolio.name,
      collectrProductId: resolved.product.id,
      collectrSubType: resolved.product.subType,
      collectrGradeId: resolved.product.gradeId,
      collectrUserOwnedProductId: resolved.product.userOwnedProductId,
      purchasePriceAdjustment,
      verified: verifiedQuantity === targetQuantity
    };
  }

  async postQuantity(resolved, body) {
    return fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products/" + encodeURIComponent(resolved.product.id), {
      collectionId: resolved.portfolio.id
    }, {
      method: "POST",
      body
    });
  }

  async verifyQuantity(resolved, body) {
    const detailRows = flattenProductDetailLines(await fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products/" + encodeURIComponent(resolved.product.id), {
      collectionId: resolved.portfolio.id,
      currency: "CAD",
      details: "false"
    }));
    const match = detailRows.find((product) =>
      String(product.product_id || "") === String(resolved.product.id || "") &&
      normalizeValue(product.product_sub_type) === normalizeValue(body.subType) &&
      String(product.grade_id || "") === String(body.gradeId)
    ) || (detailRows.length === 1 ? detailRows[0] : null);
    return match ? Number(match.quantity || 0) : 0;
  }

  async trimPurchasePrices(userOwnedProductId, targetQuantity) {
    const data = await fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products/owned/" + encodeURIComponent(userOwnedProductId) + "/purchase-prices", {
      currency: "CAD"
    });
    const rows = selectDataArray(data);
    const trimmedRows = trimPurchasePriceRows(rows, targetQuantity);
    await fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products/owned/" + encodeURIComponent(userOwnedProductId) + "/purchase-prices", {}, {
      method: "PUT",
      body: {
        currency: "CAD",
        data: trimmedRows
      }
    });
    return {
      previousPurchasePriceRows: rows.length,
      currentPurchasePriceRows: trimmedRows.length
    };
  }

  async resolveRow(row) {
    const item = row.item || {};
    const portfolioId = item.collectrCollectionId || item.collectrPortfolioId || "";
    let productId = row.collectrProductId || item.collectrProductId || "";

    const portfolio = await this.resolvePortfolio(row, portfolioId);
    if (!productId) {
      const catalogResolution = await this.resolveCatalogProduct(row, item);
      productId = String(catalogResolution.product.product_id || catalogResolution.product.id || "").trim();
    }
    if (!productId) throw new Error("Collectr product ID is required for " + row.cardId + ".");
    const ownedRows = selectDataArray(await fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products", {
      collectionId: portfolio.id,
      productIds: productId,
      unstackedView: true,
      currency: "CAD"
    }));
    const detailRows = flattenProductDetailLines(await fetchCollectrJson(this.config, "/collections/" + encodeURIComponent(this.config.accountId) + "/products/" + encodeURIComponent(productId), {
      collectionId: portfolio.id,
      currency: "CAD",
      details: "false"
    }));
    const lines = detailRows.length ? detailRows : ownedRows;
    const selected = this.selectOwnedLine(row, lines, productId);
    return {
      portfolio,
      product: {
        id: String(productId),
        subType: selected.product_sub_type || row.collectrSubType || item.collectrSubType || item.variance || "",
        gradeId: selected.grade_id || row.collectrGradeId || item.collectrGradeId ||
          (normalizeValue(item.grade) === "ungraded" ? UNGRADED_GRADE_ID : ""),
        userOwnedProductId: selected.user_owned_product_id || row.collectrUserOwnedProductId || item.collectrUserOwnedProductId || ""
      }
    };
  }

  async resolveCatalogProduct(row, item) {
    const searchItem = {
      ...item,
      cardId: row.cardId || item.cardId,
      collectrSubType: row.collectrSubType || item.collectrSubType,
      variance: item.variance || row.collectrSubType
    };
    const searchString = buildCatalogSearchString(searchItem);
    if (!searchString) throw new Error("Inventory row does not have enough detail to search Collectr for " + row.cardId + ".");
    const data = await fetchCollectrJson(this.config, "/catalog", {
      username: this.config.accountId,
      searchString,
      filters: "",
      offset: 0,
      limit: 30,
      unstackedView: "true"
    });
    return findUniqueCatalogProduct(searchItem, selectDataArray(data));
  }

  async resolvePortfolio(row, directId) {
    if (directId) {
      return { id: String(directId), name: row.collectrPortfolioName || row.item && row.item.portfolioName || "" };
    }
    const expected = normalizeValue(row.collectrPortfolioName || row.item && row.item.portfolioName || "");
    const portfolios = selectDataArray(await fetchCollectrJson(this.config, "/accounts/" + encodeURIComponent(this.config.accountId) + "/collections"));
    const match = portfolios.find((portfolio) => normalizeValue(portfolio.name || portfolio.collection_name) === expected);
    if (!match) throw new Error("Collectr portfolio not found for " + row.cardId + ".");
    return { id: match.id || match.collection_id, name: match.name || match.collection_name || "" };
  }

  selectOwnedLine(row, lines, productId) {
    const expectedOwnedId = String(row.collectrUserOwnedProductId || row.item && row.item.collectrUserOwnedProductId || "").trim();
    const expectedSubtype = normalizeValue(row.collectrSubType || row.item && (row.item.collectrSubType || row.item.variance) || "");
    const expectedGradeId = String(row.collectrGradeId || row.item && row.item.collectrGradeId || "").trim();
    const byOwnedId = expectedOwnedId
      ? lines.find((line) => String(line.user_owned_product_id || "") === expectedOwnedId)
      : null;
    if (byOwnedId) return byOwnedId;
    const exact = lines.filter((line) =>
      String(line.product_id || "") === String(productId) &&
      (!expectedSubtype || normalizeValue(line.product_sub_type) === expectedSubtype) &&
      (!expectedGradeId || String(line.grade_id || "") === expectedGradeId)
    );
    if (exact.length === 1) return exact[0];
    const subtype = expectedSubtype
      ? lines.filter((line) => String(line.product_id || "") === String(productId) && normalizeValue(line.product_sub_type) === expectedSubtype)
      : [];
    if (subtype.length === 1) return subtype[0];
    if (lines.length === 1) return lines[0];
    return {};
  }

  serializeJob(job) {
    const result = job.result || {};
    return {
      id: job.id,
      state: job.state,
      sessionId: job.payload.sessionId || result.sessionId || "",
      total: Number(result.total || job.payload.total || 0),
      completed: Number(result.completed || 0),
      failed: Number(result.failed || 0),
      rows: Object.values(result.rowsById || {}),
      error: job.error || "",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }
}

module.exports = {
  AuditCollectrSyncService,
  JOB_TYPE
};
