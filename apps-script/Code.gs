const BOT_CONFIG_SHEET = "Bot Config";
const CAPTURE_SESSIONS_SHEET = "CaptureSessions";
const AUDIT_SESSIONS_SHEET = "AuditSessions";
const AUDIT_SCANS_SHEET = "AuditScans";
const SALES_LOG_TEMPLATE_SHEET = "Sales Log - Template";
const SINGLES_INVENTORY_SHEET = "Singles Inventory";
const SLABS_INVENTORY_SHEET = "Slabs Inventory";
const SINGLES_CARD_ID_COLUMN_INDEX = 17;
const SLABS_CARD_ID_COLUMN_INDEX = 17;

const SALES_LOG_HEADERS = [
  "Time",
  "Product",
  "Owner",
  "Category",
  "Quantity",
  "Total",
  "Notes",
  "Card ID",
  "Image Link"
];

const SALES_LOG_METADATA_HEADERS = [
  "__record_key",
  "__sort_key",
  "__message_id",
  "__source_timestamp_ms"
];

const CAPTURE_SESSION_HEADERS = [
  "session_id",
  "session_name",
  "sheet_tab_name",
  "group_id",
  "started_at",
  "started_by",
  "ended_at",
  "ended_by",
  "status"
];

const AUDIT_SESSION_HEADERS = [
  "session_id",
  "session_name",
  "sheet_tab_name",
  "thread_id",
  "started_at",
  "started_by",
  "ended_at",
  "ended_by",
  "status"
];

const AUDIT_SCAN_HEADERS = [
  "session_id",
  "record_key",
  "scanned_at",
  "card_id",
  "status",
  "undone_at",
  "message_id",
  "source_timestamp_ms",
  "inventory_status",
  "manual_review",
  "inventory_match",
  "notes"
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Inventory Bot")
    .addItem("Setup Bot Sheets", "setupBotSheets")
    .addItem("Refresh Audit Review Markers", "refreshAuditReviewMarkers")
    .addToUi();
}

function setupBotSheets() {
  getConfigSheet_();
  getCaptureSessionsSheet_();
  getAuditSessionsSheet_();
  getAuditScansSheet_();
  getSalesLogTemplateSheet_();
  SpreadsheetApp.getUi().alert("Bot sheets are ready.");
}

function doGet(e) {
  try {
    const path = String(e.parameter.path || "").trim();

    if (path === "capture/status") {
      return jsonResponse_({
        ok: true,
        activeSession: getActiveCaptureSession_(e.parameter.groupId || "")
      });
    }

    if (path === "inventory/lookup") {
      return jsonResponse_({ ok: true, item: getInventoryLookupItem_(e.parameter.cardId) });
    }

    if (path === "inventory/lookup-snapshot") {
      return jsonResponse_({ ok: true, snapshot: getInventoryLookupSnapshot_() });
    }

    if (path === "inventory/sticker-targets") {
      return jsonResponse_({
        ok: true,
        result: getInventoryStickerTargets_({
          cardId: e.parameter.cardId,
          sheetName: e.parameter.sheetName,
          rowNumber: e.parameter.rowNumber
        })
      });
    }

    if (path === "audit/status") {
      return jsonResponse_({
        ok: true,
        result: getAuditStatus_({
          threadId: e.parameter.threadId,
          sessionId: e.parameter.sessionId
        })
      });
    }

    if (path === "audit/sessions") {
      return jsonResponse_({
        ok: true,
        result: getAuditSessions_({
          limit: e.parameter.limit
        })
      });
    }

    return jsonResponse_({ ok: false, error: "Unknown GET path: " + path });
  } catch (error) {
    return jsonResponse_({ ok: false, error: error.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    const path = String(body.path || "").trim();
    const payload = body.payload || {};

    if (path === "capture/start") {
      return jsonResponse_({ ok: true, session: startCaptureSession_(payload) });
    }

    if (path === "capture/stop") {
      return jsonResponse_({ ok: true, session: stopCaptureSession_(payload) });
    }

    if (path === "capture/scan") {
      return jsonResponse_({ ok: true, result: recordCaptureScans_(payload) });
    }

    if (path === "inventory/sticker-price") {
      return jsonResponse_({ ok: true, result: updateInventoryStickerPrice_(payload) });
    }

    if (path === "audit/start") {
      return jsonResponse_({ ok: true, session: startAuditSession_(payload) });
    }

    if (path === "audit/stop") {
      return jsonResponse_({ ok: true, session: stopAuditSession_(payload) });
    }

    if (path === "audit/scan") {
      return jsonResponse_({ ok: true, result: recordAuditScan_(payload) });
    }

    if (path === "audit/undo") {
      return jsonResponse_({ ok: true, result: undoAuditScan_(payload) });
    }

    if (path === "audit/scans") {
      return jsonResponse_({ ok: true, result: getAuditScans_(payload) });
    }

    if (path === "audit/summary") {
      return jsonResponse_({ ok: true, summary: getAuditSummary_(payload) });
    }

    return jsonResponse_({ ok: false, error: "Unknown POST path: " + path });
  } catch (error) {
    return jsonResponse_({ ok: false, error: error.message });
  }
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet_(sheetName) {
  const spreadsheet = getSpreadsheet_();
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}

function ensureHeaders_(sheet, headers) {
  const width = headers.length;
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  const existing = sheet.getRange(1, 1, 1, width).getValues()[0];
  const missing = headers.some(function (header, index) {
    return String(existing[index] || "").trim() !== header;
  });

  if (missing) {
    sheet.getRange(1, 1, 1, width).setValues([headers]);
    sheet.setFrozenRows(1);
  }
}

function getConfigSheet_() {
  const sheet = getOrCreateSheet_(BOT_CONFIG_SHEET);
  ensureHeaders_(sheet, ["Key", "Value"]);
  return sheet;
}

function getCaptureSessionsSheet_() {
  const sheet = getOrCreateSheet_(CAPTURE_SESSIONS_SHEET);
  ensureHeaders_(sheet, CAPTURE_SESSION_HEADERS);
  return sheet;
}

function getAuditSessionsSheet_() {
  const sheet = getOrCreateSheet_(AUDIT_SESSIONS_SHEET);
  ensureHeaders_(sheet, AUDIT_SESSION_HEADERS);
  return sheet;
}

function getAuditScansSheet_() {
  const sheet = getOrCreateSheet_(AUDIT_SCANS_SHEET);
  ensureHeaders_(sheet, AUDIT_SCAN_HEADERS);
  return sheet;
}

function getSalesLogTemplateSheet_() {
  const sheet = getOrCreateSheet_(SALES_LOG_TEMPLATE_SHEET);
  ensureHeaders_(sheet, SALES_LOG_HEADERS.concat(SALES_LOG_METADATA_HEADERS));
  return sheet;
}

function getSheetRows_(sheetName) {
  const sheet = getOrCreateSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return [];
  }

  const headers = values[0];
  return values.slice(1).filter(function (row) {
    return row.some(function (cell) { return cell !== ""; });
  }).map(function (row, index) {
    const item = { __rowNumber: index + 2 };
    headers.forEach(function (header, columnIndex) {
      item[header] = row[columnIndex];
    });
    return item;
  });
}

function getHeaderMap_(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  const byHeader = {};
  headers.forEach(function (header, index) {
    const key = String(header || "").trim();
    if (key) {
      byHeader[key] = index + 1;
    }
  });
  return byHeader;
}

function normalizeHeaderName_(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getHeaderIndexByCandidates_(headers, candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const directIndex = headers.indexOf(candidate);
    if (directIndex !== -1) {
      return directIndex;
    }
    const normalizedCandidate = normalizeHeaderName_(candidate);
    for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
      if (normalizeHeaderName_(headers[headerIndex]) === normalizedCandidate) {
        return headerIndex;
      }
    }
  }
  return -1;
}

function getHeaderValue_(row, headers, candidates) {
  const index = getHeaderIndexByCandidates_(headers, candidates);
  return index === -1 ? "" : row[index];
}

function getHeaderValueByPrefix_(row, headers, candidates) {
  const normalizedCandidates = candidates.map(function (candidate) {
    return String(candidate).toLowerCase();
  });
  for (let index = 0; index < headers.length; index += 1) {
    const normalizedHeader = String(headers[index] || "").trim().toLowerCase();
    if (normalizedCandidates.some(function (candidate) {
      return normalizedHeader === candidate ||
        normalizedHeader.indexOf(candidate + " ") === 0 ||
        normalizedHeader.indexOf(candidate + " (") === 0;
    })) {
      return row[index];
    }
  }
  return "";
}

function getInventoryIdColumnIndexes_(headers, preferredIdColumnIndex) {
  const candidates = [
    "generated_id",
    "Generated ID",
    "Card ID",
    "card_id",
    "ID",
    "id",
    "Inventory ID",
    "inventory_id",
    "Item ID",
    "item_id"
  ];
  const indexes = [];

  candidates.forEach(function (candidate) {
    const headerIndex = getHeaderIndexByCandidates_(headers, [candidate]);
    if (headerIndex !== -1 && indexes.indexOf(headerIndex) === -1) {
      indexes.push(headerIndex);
    }
  });

  if (!indexes.length && preferredIdColumnIndex) {
    indexes.push(preferredIdColumnIndex - 1);
  }

  return indexes;
}

function splitInventoryCardIds_(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map(function (cardId) { return String(cardId || "").trim(); })
    .filter(Boolean);
}

function getInventoryIdFromRow_(row, headers, preferredIdColumnIndex) {
  const idColumnIndexes = getInventoryIdColumnIndexes_(headers, preferredIdColumnIndex);
  for (let index = 0; index < idColumnIndexes.length; index += 1) {
    const values = splitInventoryCardIds_(row[idColumnIndexes[index]]);
    if (values.length) {
      return values[0];
    }
  }
  return "";
}

function findInventoryRowByIdInSheet_(sheetName, cardId, preferredIdColumnIndex) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    return null;
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) {
    return null;
  }

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const idColumnIndexes = getInventoryIdColumnIndexes_(headers, preferredIdColumnIndex);
  const normalizedCardId = String(cardId || "").trim();

  for (let index = 0; index < idColumnIndexes.length; index += 1) {
    const columnIndex = idColumnIndexes[index];
    const values = sheet.getRange(2, columnIndex + 1, lastRow - 1, 1).getValues();

    for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
      const cardIds = splitInventoryCardIds_(values[rowIndex][0]);
      if (cardIds.some(function (candidate) {
        return candidate.toUpperCase() === normalizedCardId.toUpperCase();
      })) {
        const rowNumber = rowIndex + 2;
        return {
          sheet: sheet,
          sheetName: sheetName,
          category: sheetName === SLABS_INVENTORY_SHEET ? "Slabs" : "Singles",
          rowNumber: rowNumber,
          row: sheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0],
          headers: headers
        };
      }
    }
  }

  return null;
}

function findInventoryByCardId_(cardId) {
  return findInventoryRowByIdInSheet_(SINGLES_INVENTORY_SHEET, cardId, SINGLES_CARD_ID_COLUMN_INDEX) ||
    findInventoryRowByIdInSheet_(SLABS_INVENTORY_SHEET, cardId, SLABS_CARD_ID_COLUMN_INDEX);
}

function buildInventoryLookupItem_(match, normalizedCardId) {
  const fields = {};
  match.headers.forEach(function (header, index) {
    if (String(header || "").trim()) {
      fields[String(header)] = match.row[index];
    }
  });

  return {
    cardId: normalizedCardId,
    sheetName: match.sheetName,
    rowNumber: match.rowNumber,
    category: match.category,
    name: getHeaderValue_(match.row, match.headers, ["Product Name", "Product", "Name", "Card Name"]),
    setName: getHeaderValue_(match.row, match.headers, ["Set", "Set Name", "set_name"]),
    cardNumber: getHeaderValue_(match.row, match.headers, ["Card Number", "card_number"]),
    marketPrice: getHeaderValueByPrefix_(match.row, match.headers, ["Market Price", "Current Market Price"]),
    suggestedPrice: getHeaderValue_(match.row, match.headers, ["Suggested Price", "Price", "Asking Price"]),
    stickeredPrice: getHeaderValue_(match.row, match.headers, ["Stickered Price"]),
    lastStickered: getHeaderValue_(match.row, match.headers, ["Last Stickered"]),
    quantity: getHeaderValue_(match.row, match.headers, ["Quantity", "Qty", "QTY", "Available", "Available Quantity", "Count"]),
    condition: getHeaderValue_(match.row, match.headers, ["Card Condition", "Condition"]),
    variance: getHeaderValue_(match.row, match.headers, ["Variance", "Variant"]),
    grade: getHeaderValue_(match.row, match.headers, ["Grade"]),
    portfolioName: getHeaderValue_(match.row, match.headers, ["Portfolio Name", "Portfolio", "Owner"]),
    collectrCollectionId: getHeaderValue_(match.row, match.headers, ["Collectr Collection ID", "Collectr Portfolio ID"]),
    collectrProductId: getHeaderValue_(match.row, match.headers, ["Collectr Product ID", "Product ID"]),
    collectrSubType: getHeaderValue_(match.row, match.headers, ["Collectr SubType", "Collectr Subtype", "Product Sub Type"]),
    collectrGradeId: getHeaderValue_(match.row, match.headers, ["Collectr Grade ID", "Grade ID"]),
    collectrUserOwnedProductId: getHeaderValue_(match.row, match.headers, ["Collectr User Owned Product ID", "User Owned Product ID"]),
    collectrLastSynced: getHeaderValue_(match.row, match.headers, ["Collectr Last Synced"]),
    collectrSyncStatus: getHeaderValue_(match.row, match.headers, ["Collectr Sync Status"]),
    imageUrl: getHeaderValue_(match.row, match.headers, ["Image URL", "Image Link", "image_url"]),
    fields: fields
  };
}

function getInventoryLookupItem_(cardId) {
  const normalizedCardId = String(cardId || "").trim();
  if (!normalizedCardId) {
    throw new Error("Card ID is required.");
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = "inventory-lookup:" + normalizedCardId.toUpperCase();
  const cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const match = findInventoryByCardId_(normalizedCardId);
  if (!match) {
    return null;
  }

  const item = buildInventoryLookupItem_(match, normalizedCardId);
  cache.put(cacheKey, JSON.stringify(item), 60);
  return item;
}

function getInventoryLookupSnapshot_() {
  const startedAt = new Date();
  const itemsById = {};
  const duplicateIds = [];
  let rowCount = 0;

  [
    { sheetName: SINGLES_INVENTORY_SHEET, preferredIdColumnIndex: SINGLES_CARD_ID_COLUMN_INDEX },
    { sheetName: SLABS_INVENTORY_SHEET, preferredIdColumnIndex: SLABS_CARD_ID_COLUMN_INDEX }
  ].forEach(function (source) {
    const sheet = getSpreadsheet_().getSheetByName(source.sheetName);
    if (!sheet) {
      return;
    }

    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) {
      return;
    }

    const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
    const headers = values[0];
    const idColumnIndexes = getInventoryIdColumnIndexes_(headers, source.preferredIdColumnIndex);

    for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
      const row = values[rowIndex];
      if (!row.some(function (cell) { return cell !== ""; })) {
        continue;
      }
      rowCount += 1;

      const cardIds = [];
      idColumnIndexes.forEach(function (columnIndex) {
        splitInventoryCardIds_(row[columnIndex]).forEach(function (cardId) {
          if (cardIds.indexOf(cardId) !== -1) {
            return;
          }
          cardIds.push(cardId);
        });
      });
      if (!cardIds.length) {
        continue;
      }

      const match = {
        sheet: sheet,
        sheetName: source.sheetName,
        category: source.sheetName === SLABS_INVENTORY_SHEET ? "Slabs" : "Singles",
        rowNumber: rowIndex + 1,
        row: row,
        headers: headers
      };

      cardIds.forEach(function (cardId) {
        const normalizedCardId = cardId.toUpperCase();
        if (itemsById[normalizedCardId]) {
          duplicateIds.push(cardId);
          return;
        }
        itemsById[normalizedCardId] = buildInventoryLookupItem_(match, cardId);
      });
    }
  });

  return {
    generatedAt: startedAt.toISOString(),
    rowCount: rowCount,
    itemCount: Object.keys(itemsById).length,
    duplicateIds: duplicateIds,
    itemsById: itemsById
  };
}

function findInventoryMatchForStickerUpdate_(payload, cardId) {
  const sheetName = String(payload.sheetName || "").trim();
  const rowNumber = Number(payload.rowNumber || 0);
  if ([SINGLES_INVENTORY_SHEET, SLABS_INVENTORY_SHEET].indexOf(sheetName) !== -1 && rowNumber > 1) {
    const sheet = getSpreadsheet_().getSheetByName(sheetName);
    if (sheet && rowNumber <= sheet.getLastRow()) {
      const lastColumn = sheet.getLastColumn();
      const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
      const row = sheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0];
      const preferredIdColumn = sheetName === SLABS_INVENTORY_SHEET ? SLABS_CARD_ID_COLUMN_INDEX : SINGLES_CARD_ID_COLUMN_INDEX;
      const idColumnIndexes = getInventoryIdColumnIndexes_(headers, preferredIdColumn);
      const verified = idColumnIndexes.some(function (columnIndex) {
        return String(row[columnIndex] || "").trim().toUpperCase() === cardId.toUpperCase();
      });
      if (verified) {
        return {
          sheet: sheet,
          sheetName: sheetName,
          category: sheetName === SLABS_INVENTORY_SHEET ? "Slabs" : "Singles",
          rowNumber: rowNumber,
          row: row,
          headers: headers
        };
      }
    }
  }
  return findInventoryByCardId_(cardId);
}

function getInventoryIdentity_(row, headers, sheetName) {
  return {
    sheetName: sheetName,
    portfolioName: String(getHeaderValue_(row, headers, ["Portfolio Name", "Portfolio", "Owner"]) || "").trim(),
    setName: String(getHeaderValue_(row, headers, ["Set", "Set Name", "set_name"]) || "").trim(),
    productName: String(getHeaderValue_(row, headers, ["Product Name", "Product", "Name", "Card Name"]) || "").trim(),
    cardNumber: String(getHeaderValue_(row, headers, ["Card Number", "Number", "card_number"]) || "").trim(),
    rarity: String(getHeaderValue_(row, headers, ["Rarity"]) || "").trim(),
    variance: String(getHeaderValue_(row, headers, ["Variance", "Variant"]) || "").trim(),
    grade: String(getHeaderValue_(row, headers, ["Grade"]) || "").trim(),
    condition: String(getHeaderValue_(row, headers, ["Card Condition", "Condition"]) || "").trim(),
    quantity: Number(getHeaderValue_(row, headers, ["Quantity", "Qty", "QTY", "Available", "Available Quantity", "Count"]) || 0)
  };
}

function buildStickerPriceIdentityKey_(row, headers, sheetName) {
  const identity = getInventoryIdentity_(row, headers, sheetName);
  return [
    identity.sheetName,
    identity.setName,
    identity.productName,
    identity.cardNumber,
    identity.rarity,
    identity.variance,
    identity.grade,
    identity.condition
  ].map(function (value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }).join("|");
}

function summarizeStickerTargetPortfolios_(match) {
  const sheetValues = match.sheet.getDataRange().getValues();
  const targetIdentityKey = buildStickerPriceIdentityKey_(match.row, match.headers, match.sheetName);
  const countsByPortfolio = {};
  const quantityByPortfolio = {};
  let totalRows = 0;
  for (let rowIndex = 1; rowIndex < sheetValues.length; rowIndex += 1) {
    const row = sheetValues[rowIndex];
    if (buildStickerPriceIdentityKey_(row, match.headers, match.sheetName) !== targetIdentityKey) {
      continue;
    }
    const portfolioName = String(getHeaderValue_(row, match.headers, ["Portfolio Name", "Owner"]) || "Not specified").trim();
    countsByPortfolio[portfolioName] = (countsByPortfolio[portfolioName] || 0) + 1;
    quantityByPortfolio[portfolioName] = (quantityByPortfolio[portfolioName] || 0) + Number(
      getHeaderValue_(row, match.headers, ["Quantity", "Qty", "QTY", "Available", "Available Quantity", "Count"]) || 0
    );
    totalRows += 1;
  }
  return {
    totalRows: totalRows,
    portfolios: Object.keys(countsByPortfolio).sort().map(function (name) {
      return { name: name, rowCount: countsByPortfolio[name], quantity: quantityByPortfolio[name] };
    })
  };
}

function getInventoryStickerTargets_(payload) {
  const cardId = String(payload.cardId || "").trim();
  if (!cardId) {
    throw new Error("Card ID is required.");
  }
  const cache = CacheService.getScriptCache();
  const cacheKey = "sticker-targets-v2:" + cardId.toUpperCase();
  const cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  const match = findInventoryMatchForStickerUpdate_(payload, cardId);
  if (!match) {
    throw new Error("Card ID not found in Singles Inventory or Slabs Inventory: " + cardId);
  }
  const result = summarizeStickerTargetPortfolios_(match);
  cache.put(cacheKey, JSON.stringify(result), 60);
  return result;
}

function updateInventoryStickerPrice_(payload) {
  const cardId = String(payload.cardId || "").trim();
  if (!cardId) {
    throw new Error("Card ID is required.");
  }

  const rawPrice = payload.stickeredPrice;
  const blankPrice = rawPrice === "" || rawPrice === null || rawPrice === undefined;
  const stickeredPrice = blankPrice ? "" : Number(rawPrice);
  if (!blankPrice && (!Number.isFinite(stickeredPrice) || stickeredPrice < 0)) {
    throw new Error("Stickered Price must be a non-negative number or blank.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const match = findInventoryMatchForStickerUpdate_(payload, cardId);
    if (!match) {
      throw new Error("Card ID not found in Singles Inventory or Slabs Inventory: " + cardId);
    }

    const stickeredPriceColumn = match.headers.findIndex(function (header) {
      return normalizeHeaderName_(header) === "stickeredprice";
    });
    const lastStickeredColumn = match.headers.findIndex(function (header) {
      return normalizeHeaderName_(header) === "laststickered";
    });
    if (stickeredPriceColumn === -1 || lastStickeredColumn === -1) {
      throw new Error("Inventory sheet must contain Stickered Price and Last Stickered columns.");
    }

    const sheetValues = match.sheet.getDataRange().getValues();
    const targetIdentityKey = buildStickerPriceIdentityKey_(match.row, match.headers, match.sheetName);
    const updatedAt = new Date();
    const updates = [];
    let matchedRows = 0;
    const countsByPortfolio = {};
    const quantityByPortfolio = {};

    for (let rowIndex = 1; rowIndex < sheetValues.length; rowIndex += 1) {
      const row = sheetValues[rowIndex];
      if (buildStickerPriceIdentityKey_(row, match.headers, match.sheetName) !== targetIdentityKey) {
        continue;
      }
      matchedRows += 1;
      const portfolioName = String(getHeaderValue_(row, match.headers, ["Portfolio Name", "Owner"]) || "Not specified").trim();
      countsByPortfolio[portfolioName] = (countsByPortfolio[portfolioName] || 0) + 1;
      quantityByPortfolio[portfolioName] = (quantityByPortfolio[portfolioName] || 0) + Number(
        getHeaderValue_(row, match.headers, ["Quantity", "Qty", "QTY", "Available", "Available Quantity", "Count"]) || 0
      );
      const currentValue = row[stickeredPriceColumn];
      const currentBlank = currentValue === "" || currentValue === null || currentValue === undefined;
      const rowChanged = blankPrice
        ? !currentBlank
        : currentBlank || Number(currentValue) !== stickeredPrice;
      if (!rowChanged) {
        continue;
      }
      row[stickeredPriceColumn] = stickeredPrice;
      row[lastStickeredColumn] = updatedAt;
      updates.push({ rowNumber: rowIndex + 1, row: row });
    }

    updates.forEach(function (update) {
      if (Math.abs(stickeredPriceColumn - lastStickeredColumn) === 1) {
        const firstColumn = Math.min(stickeredPriceColumn, lastStickeredColumn);
        match.sheet.getRange(update.rowNumber, firstColumn + 1, 1, 2).setValues([[
          update.row[firstColumn],
          update.row[firstColumn + 1]
        ]]);
      } else {
        match.sheet.getRange(update.rowNumber, stickeredPriceColumn + 1).setValue(stickeredPrice);
        match.sheet.getRange(update.rowNumber, lastStickeredColumn + 1).setValue(updatedAt);
      }
      const updatedId = getInventoryIdFromRow_(update.row, match.headers, 0);
      if (updatedId) {
        CacheService.getScriptCache().remove("inventory-lookup:" + updatedId.toUpperCase());
        CacheService.getScriptCache().remove("sticker-targets-v2:" + updatedId.toUpperCase());
      }
      if (update.rowNumber === match.rowNumber) {
        match.row = update.row;
      }
    });

    const item = buildInventoryLookupItem_(match, cardId);
    CacheService.getScriptCache().put("inventory-lookup:" + cardId.toUpperCase(), JSON.stringify(item), 60);
    return {
      changed: updates.length > 0,
      matchedRows: matchedRows,
      changedRows: updates.length,
      portfolios: Object.keys(countsByPortfolio).sort().map(function (name) {
        return { name: name, rowCount: countsByPortfolio[name], quantity: quantityByPortfolio[name] };
      }),
      item: item
    };
  } finally {
    lock.releaseLock();
  }
}

function formatLocalDateKey_(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function sanitizeSheetName_(value) {
  return String(value || "Capture")
    .replace(/[\[\]\*\/\\\?:]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 90) || "Capture";
}

function buildSalesLogSheetName_(sessionName) {
  return sanitizeSheetName_("Sales Log - " + formatLocalDateKey_(new Date()) + " - " + String(sessionName || "Session").trim());
}

function createSalesLogSheet_(sessionName) {
  const spreadsheet = getSpreadsheet_();
  const template = getSalesLogTemplateSheet_();
  let sheetName = buildSalesLogSheetName_(sessionName);
  let suffix = 2;

  while (spreadsheet.getSheetByName(sheetName)) {
    sheetName = sanitizeSheetName_(buildSalesLogSheetName_(sessionName) + " " + suffix);
    suffix += 1;
  }

  const sheet = template.copyTo(spreadsheet).setName(sheetName);
  ensureHeaders_(sheet, SALES_LOG_HEADERS.concat(SALES_LOG_METADATA_HEADERS));
  clearSalesLogDataArea_(sheet);
  return sheet;
}

function getActiveCaptureSession_(groupId) {
  const normalizedGroupId = String(groupId || "").trim();
  const sessions = getSheetRows_(CAPTURE_SESSIONS_SHEET);

  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (String(session.status || "").trim().toLowerCase() !== "active") {
      continue;
    }
    if (normalizedGroupId && String(session.group_id || "").trim() !== normalizedGroupId) {
      continue;
    }
    return serializeSession_(session);
  }

  return null;
}

function serializeSession_(session) {
  const output = {};
  CAPTURE_SESSION_HEADERS.forEach(function (header) {
    const value = session[header];
    output[header] = value instanceof Date ? value.toISOString() : value;
  });
  return output;
}

function startCaptureSession_(payload) {
  const groupId = String(payload.groupId || payload.threadId || "").trim();
  const sessionName = String(payload.sessionName || "").trim() || "Capture";
  const startedBy = String(payload.startedBy || "").trim();

  if (!groupId) {
    throw new Error("groupId is required.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const existing = getActiveCaptureSession_(groupId);
    if (existing) {
      return existing;
    }

    const sheet = createSalesLogSheet_(sessionName);
    const session = {
      session_id: Utilities.getUuid(),
      session_name: sessionName,
      sheet_tab_name: sheet.getName(),
      group_id: groupId,
      started_at: new Date(),
      started_by: startedBy,
      ended_at: "",
      ended_by: "",
      status: "active"
    };

    getCaptureSessionsSheet_().appendRow(CAPTURE_SESSION_HEADERS.map(function (header) {
      return session[header];
    }));

    SpreadsheetApp.flush();
    return serializeSession_(session);
  } finally {
    lock.releaseLock();
  }
}

function stopCaptureSession_(payload) {
  const groupId = String(payload.groupId || payload.threadId || "").trim();
  const endedBy = String(payload.endedBy || "").trim();

  if (!groupId) {
    throw new Error("groupId is required.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getCaptureSessionsSheet_();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      return null;
    }

    const headers = values[0];
    const groupIndex = headers.indexOf("group_id");
    const statusIndex = headers.indexOf("status");
    const endedAtIndex = headers.indexOf("ended_at");
    const endedByIndex = headers.indexOf("ended_by");

    for (let rowIndex = values.length - 1; rowIndex >= 1; rowIndex -= 1) {
      if (String(values[rowIndex][groupIndex] || "").trim() === groupId &&
          String(values[rowIndex][statusIndex] || "").trim().toLowerCase() === "active") {
        const rowNumber = rowIndex + 1;
        const endedAt = new Date();
        sheet.getRange(rowNumber, statusIndex + 1).setValue("ended");
        sheet.getRange(rowNumber, endedAtIndex + 1).setValue(endedAt);
        sheet.getRange(rowNumber, endedByIndex + 1).setValue(endedBy);
        SpreadsheetApp.flush();

        const session = {};
        headers.forEach(function (header, columnIndex) {
          session[header] = columnIndex === statusIndex
            ? "ended"
            : columnIndex === endedAtIndex
              ? endedAt
              : columnIndex === endedByIndex
                ? endedBy
                : values[rowIndex][columnIndex];
        });
        return serializeSession_(session);
      }
    }

    return null;
  } finally {
    lock.releaseLock();
  }
}

function buildAuditLogSheetName_(sessionName) {
  return sanitizeSheetName_("Audit Log - " + formatLocalDateKey_(new Date()) + " - " + String(sessionName || "Session").trim());
}

function createAuditLogSheet_(sessionName) {
  const spreadsheet = getSpreadsheet_();
  let sheetName = buildAuditLogSheetName_(sessionName);
  let suffix = 2;

  while (spreadsheet.getSheetByName(sheetName)) {
    sheetName = sanitizeSheetName_(buildAuditLogSheetName_(sessionName) + " " + suffix);
    suffix += 1;
  }

  const sheet = spreadsheet.insertSheet(sheetName);
  ensureHeaders_(sheet, AUDIT_SCAN_HEADERS);
  return sheet;
}

function serializeAuditSession_(session) {
  const output = {};
  AUDIT_SESSION_HEADERS.forEach(function (header) {
    const value = session[header];
    output[header] = value instanceof Date ? value.toISOString() : value;
  });
  return output;
}

function startAuditSession_(payload) {
  const threadId = String(payload.threadId || "").trim() || "pwa-audit";
  const sessionName = String(payload.sessionName || "").trim() || "Inventory audit";
  const startedBy = String(payload.startedBy || "").trim();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const logSheet = createAuditLogSheet_(sessionName);
    const session = {
      session_id: Utilities.getUuid(),
      session_name: sessionName,
      sheet_tab_name: logSheet.getName(),
      thread_id: threadId,
      started_at: new Date(),
      started_by: startedBy,
      ended_at: "",
      ended_by: "",
      status: "active"
    };

    getAuditSessionsSheet_().appendRow(AUDIT_SESSION_HEADERS.map(function (header) {
      return session[header];
    }));

    SpreadsheetApp.flush();
    return serializeAuditSession_(session);
  } finally {
    lock.releaseLock();
  }
}

function getAuditSessionById_(sessionId) {
  const sessions = getSheetRows_(AUDIT_SESSIONS_SHEET);
  const session = sessions.filter(function (row) {
    return String(row.session_id || "").trim() === String(sessionId || "").trim();
  })[0];

  if (!session) {
    throw new Error("Audit session not found.");
  }

  return session;
}

function getActiveAuditSession_(threadId) {
  const normalizedThreadId = String(threadId || "").trim() || "pwa-audit";
  const sessions = getSheetRows_(AUDIT_SESSIONS_SHEET);

  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (String(session.thread_id || "").trim() === normalizedThreadId &&
        String(session.status || "").trim().toLowerCase() === "active") {
      return session;
    }
  }

  return null;
}

function getAuditStatus_(payload) {
  const sessionId = String(payload.sessionId || "").trim();
  const session = sessionId ? getAuditSessionById_(sessionId) : getActiveAuditSession_(payload.threadId);
  if (!session) {
    return {
      session: null,
      scans: []
    };
  }

  const scans = getAuditScanRowsForSession_(session).filter(function (scan) {
    return scan.cardId && scan.status !== "undone";
  });

  return {
    session: serializeAuditSession_(session),
    scans: scans.slice(Math.max(0, scans.length - 250))
  };
}

function getAuditSessions_(payload) {
  const limit = Math.max(1, Math.min(100, Number(payload.limit || 50)));
  const sessions = getSheetRows_(AUDIT_SESSIONS_SHEET).map(function (session) {
    const scans = getAuditScanRowsForSession_(session);
    const activeScans = scans.filter(function (scan) {
      return scan.cardId && scan.status !== "undone";
    });
    const serialized = serializeAuditSession_(session);
    serialized.scanCount = scans.length;
    serialized.activeScanCount = activeScans.length;
    serialized.undoneScanCount = scans.length - activeScans.length;
    return serialized;
  });

  return {
    sessions: sessions.slice(Math.max(0, sessions.length - limit)).reverse()
  };
}

function stopAuditSession_(payload) {
  const threadId = String(payload.threadId || "").trim() || "pwa-audit";
  const endedBy = String(payload.endedBy || "").trim();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getAuditSessionsSheet_();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      return null;
    }

    const headers = values[0];
    const threadIndex = headers.indexOf("thread_id");
    const statusIndex = headers.indexOf("status");
    const endedAtIndex = headers.indexOf("ended_at");
    const endedByIndex = headers.indexOf("ended_by");

    for (let rowIndex = values.length - 1; rowIndex >= 1; rowIndex -= 1) {
      if (String(values[rowIndex][threadIndex] || "").trim() === threadId &&
          String(values[rowIndex][statusIndex] || "").trim().toLowerCase() === "active") {
        const rowNumber = rowIndex + 1;
        const endedAt = new Date();
        sheet.getRange(rowNumber, statusIndex + 1).setValue("ended");
        sheet.getRange(rowNumber, endedAtIndex + 1).setValue(endedAt);
        sheet.getRange(rowNumber, endedByIndex + 1).setValue(endedBy);
        SpreadsheetApp.flush();

        const session = {};
        headers.forEach(function (header, columnIndex) {
          session[header] = columnIndex === statusIndex
            ? "ended"
            : columnIndex === endedAtIndex
              ? endedAt
              : columnIndex === endedByIndex
                ? endedBy
                : values[rowIndex][columnIndex];
        });
        return serializeAuditSession_(session);
      }
    }

    return null;
  } finally {
    lock.releaseLock();
  }
}

function buildAuditScanRecord_(payload) {
  const scans = Array.isArray(payload.scans) ? payload.scans : [];
  const scan = scans.length ? scans[0] : {};
  const sessionId = String(payload.sessionId || "").trim();
  const cardId = String(payload.cardId || scan.cardId || "").trim();
  const recordKey = String(payload.recordKey || scan.recordKey || "").trim() || Utilities.getUuid();
  const timestampMs = Number(payload.sourceTimestampMs || Date.now());

  if (!sessionId) {
    throw new Error("Audit session is required.");
  }
  if (!cardId) {
    throw new Error("Card ID is required.");
  }

  return {
    session_id: sessionId,
    record_key: recordKey,
    scanned_at: new Date(timestampMs),
    card_id: cardId,
    status: "active",
    inventory_status: "",
    manual_review: "",
    inventory_match: "",
    notes: String(payload.notes || scan.notes || "").trim(),
    undone_at: "",
    message_id: String(payload.messageId || "").trim(),
    source_timestamp_ms: timestampMs
  };
}

function annotateAuditRecordInventoryStatus_(record) {
  const fields = getAuditInventoryReviewFields_(record.card_id);
  record.inventory_status = fields.inventory_status;
  record.manual_review = fields.manual_review;
  record.inventory_match = fields.inventory_match;
  return record;
}

function getAuditInventoryReviewFields_(cardId) {
  const item = getInventoryLookupItem_(cardId);
  if (!item) {
    return {
      inventory_status: "not_found",
      manual_review: "REVIEW: scanned Card ID was not found in Singles Inventory or Slabs Inventory.",
      inventory_match: ""
    };
  }

  return {
    inventory_status: "found",
    manual_review: "",
    inventory_match: [
      item.sheetName,
      item.rowNumber ? "row " + item.rowNumber : "",
      item.name || ""
    ].filter(Boolean).join(" | ")
  };
}

function refreshAuditReviewMarkers() {
  const sessions = getSheetRows_(AUDIT_SESSIONS_SHEET);
  if (!sessions.length) {
    SpreadsheetApp.getUi().alert("No audit sessions found.");
    return;
  }

  const activeSessions = sessions.filter(function (session) {
    return String(session.status || "").trim().toLowerCase() === "active";
  });
  const session = (activeSessions.length ? activeSessions : sessions)[(activeSessions.length ? activeSessions : sessions).length - 1];
  const result = refreshAuditReviewMarkersForSession_(session, { force: true });
  SpreadsheetApp.getUi().alert(
    "Audit review markers refreshed for " + session.session_name + ".\n" +
    "Updated rows: " + result.updatedRows + "\n" +
    "Not found: " + result.notFoundRows
  );
}

function refreshAuditReviewMarkersForSession_(session, options) {
  const sessionSheet = getSpreadsheet_().getSheetByName(session.sheet_tab_name);
  const sessionResult = refreshAuditReviewMarkersInSheet_(sessionSheet, session.session_id, options);
  const indexResult = refreshAuditReviewMarkersInSheet_(getAuditScansSheet_(), session.session_id, options);
  SpreadsheetApp.flush();
  return {
    updatedRows: sessionResult.updatedRows + indexResult.updatedRows,
    notFoundRows: sessionResult.notFoundRows + indexResult.notFoundRows
  };
}

function refreshAuditReviewMarkersInSheet_(sheet, sessionId, options) {
  const refreshOptions = options || {};
  if (!sheet) {
    return { updatedRows: 0, notFoundRows: 0 };
  }
  ensureHeaders_(sheet, AUDIT_SCAN_HEADERS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return { updatedRows: 0, notFoundRows: 0 };
  }

  const headers = values[0];
  const sessionIndex = headers.indexOf("session_id");
  const cardIdIndex = headers.indexOf("card_id");
  const inventoryStatusIndex = headers.indexOf("inventory_status");
  const manualReviewIndex = headers.indexOf("manual_review");
  const inventoryMatchIndex = headers.indexOf("inventory_match");
  let updatedRows = 0;
  let notFoundRows = 0;

  if (sessionIndex === -1 || cardIdIndex === -1 || inventoryStatusIndex === -1 || manualReviewIndex === -1 || inventoryMatchIndex === -1) {
    return { updatedRows: 0, notFoundRows: 0 };
  }

  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex];
    if (String(row[sessionIndex] || "").trim() !== String(sessionId || "").trim()) {
      continue;
    }
    const cardId = String(row[cardIdIndex] || "").trim();
    const currentStatus = String(row[inventoryStatusIndex] || "").trim().toLowerCase();
    const shouldRefresh = refreshOptions.force || !currentStatus || (refreshOptions.recheckNotFound && currentStatus === "not_found");
    if (!cardId || !shouldRefresh) {
      continue;
    }
    const fields = getAuditInventoryReviewFields_(cardId);
    row[inventoryStatusIndex] = fields.inventory_status;
    row[manualReviewIndex] = fields.manual_review;
    row[inventoryMatchIndex] = fields.inventory_match;
    updatedRows += 1;
    if (fields.inventory_status === "not_found") {
      notFoundRows += 1;
    }
  }

  if (updatedRows) {
    sheet.getRange(2, 1, values.length - 1, headers.length).setValues(values.slice(1));
  }

  return { updatedRows: updatedRows, notFoundRows: notFoundRows };
}

function writeAuditRecordToSheet_(sheet, record) {
  const headerMap = getHeaderMap_(sheet);
  const recordKeyColumn = headerMap["record_key"];
  const rowValues = AUDIT_SCAN_HEADERS.map(function (header) {
    return record[header] === undefined ? "" : record[header];
  });
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2 && recordKeyColumn) {
    const keys = sheet.getRange(2, recordKeyColumn, lastRow - 1, 1).getValues();
    for (let index = 0; index < keys.length; index += 1) {
      if (String(keys[index][0] || "").trim() === record.record_key) {
        sheet.getRange(index + 2, 1, 1, AUDIT_SCAN_HEADERS.length).setValues([rowValues]);
        return { appended: 0, updated: 1 };
      }
    }
  }

  sheet.appendRow(rowValues);
  return { appended: 1, updated: 0 };
}

function recordAuditScan_(payload) {
  const record = annotateAuditRecordInventoryStatus_(buildAuditScanRecord_(payload));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const session = getAuditSessionById_(record.session_id);
    if (String(session.status || "").trim().toLowerCase() !== "active") {
      throw new Error("Audit session is not active.");
    }

    const logSheet = getSpreadsheet_().getSheetByName(session.sheet_tab_name) || getAuditScansSheet_();
    ensureHeaders_(logSheet, AUDIT_SCAN_HEADERS);
    const writeResult = writeAuditRecordToSheet_(logSheet, record);
    writeAuditRecordToSheet_(getAuditScansSheet_(), record);

    SpreadsheetApp.flush();
    return {
      appended: writeResult.appended,
      updated: writeResult.updated,
      sheetTabName: session.sheet_tab_name,
      recordKey: record.record_key
    };
  } finally {
    lock.releaseLock();
  }
}

function markAuditRecordUndone_(sheet, sessionId, recordKey, undoneAt) {
  if (!sheet) {
    return false;
  }
  const headerMap = getHeaderMap_(sheet);
  const sessionColumn = headerMap["session_id"];
  const recordKeyColumn = headerMap["record_key"];
  const statusColumn = headerMap["status"];
  const undoneAtColumn = headerMap["undone_at"];
  const lastRow = sheet.getLastRow();

  if (!sessionColumn || !recordKeyColumn || !statusColumn || !undoneAtColumn || lastRow < 2) {
    return false;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const row = values[index];
    if (String(row[sessionColumn - 1] || "").trim() === sessionId &&
        String(row[recordKeyColumn - 1] || "").trim() === recordKey) {
      const rowNumber = index + 2;
      sheet.getRange(rowNumber, statusColumn).setValue("undone");
      sheet.getRange(rowNumber, undoneAtColumn).setValue(undoneAt);
      return true;
    }
  }

  return false;
}

function undoAuditScan_(payload) {
  const sessionId = String(payload.sessionId || "").trim();
  const recordKey = String(payload.recordKey || "").trim();

  if (!sessionId) {
    throw new Error("Audit session is required.");
  }
  if (!recordKey) {
    throw new Error("Scan record key is required.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const session = getAuditSessionById_(sessionId);
    const undoneAt = new Date();
    const sessionSheet = getSpreadsheet_().getSheetByName(session.sheet_tab_name);
    const changedSessionSheet = markAuditRecordUndone_(sessionSheet, sessionId, recordKey, undoneAt);
    const changedIndexSheet = markAuditRecordUndone_(getAuditScansSheet_(), sessionId, recordKey, undoneAt);
    SpreadsheetApp.flush();

    return {
      undone: changedSessionSheet || changedIndexSheet,
      sheetTabName: session.sheet_tab_name,
      recordKey: recordKey
    };
  } finally {
    lock.releaseLock();
  }
}

function getAuditScanRowsForSession_(session) {
  const sheet = getSpreadsheet_().getSheetByName(session.sheet_tab_name) || getAuditScansSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return [];
  }

  const headers = values[0];
  return values.slice(1).filter(function (row) {
    return String(getHeaderValue_(row, headers, ["session_id"]) || "").trim() === String(session.session_id || "").trim();
  }).map(function (row) {
    return {
      cardId: String(getHeaderValue_(row, headers, ["card_id"]) || "").trim(),
      status: String(getHeaderValue_(row, headers, ["status"]) || "").trim().toLowerCase(),
      scannedAt: getHeaderValue_(row, headers, ["scanned_at"]),
      recordKey: String(getHeaderValue_(row, headers, ["record_key"]) || "").trim()
    };
  });
}

function getAuditScans_(payload) {
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("Audit session is required.");
  }

  const session = getAuditSessionById_(sessionId);
  return {
    session: serializeAuditSession_(session),
    scans: getAuditScanRowsForSession_(session)
  };
}

function getAuditSummaryStatus_(scannedCount, sheetQuantity, item) {
  if (!item) {
    return "not-in-sheet";
  }
  if (scannedCount === sheetQuantity) {
    return "match";
  }
  return scannedCount > sheetQuantity ? "over" : "short";
}

function buildAuditSummary_(session, scans, selectedSessions, options) {
  const summaryOptions = options || {};
  const activeScans = scans.filter(function (scan) {
    return scan.cardId && scan.status !== "undone";
  });
  const grouped = {};

  activeScans.forEach(function (scan) {
    const normalizedCardId = scan.cardId.toUpperCase();
    if (!grouped[normalizedCardId]) {
      grouped[normalizedCardId] = {
        cardId: scan.cardId,
        scannedCount: 0,
        recordKeys: []
      };
    }
    grouped[normalizedCardId].scannedCount += 1;
    grouped[normalizedCardId].recordKeys.push(scan.recordKey);
  });

  if (summaryOptions.includeUnscannedInventory) {
    const inventorySnapshot = getInventoryLookupSnapshot_();
    Object.keys(inventorySnapshot.itemsById || {}).forEach(function (normalizedCardId) {
      const item = inventorySnapshot.itemsById[normalizedCardId];
      const sheetQuantity = Number(item.quantity || 0);
      if (sheetQuantity <= 0 || grouped[normalizedCardId]) {
        return;
      }
      grouped[normalizedCardId] = {
        cardId: item.cardId || normalizedCardId,
        scannedCount: 0,
        sheetQuantity: sheetQuantity,
        recordKeys: [],
        item: item
      };
    });
  }

  const rows = Object.keys(grouped).sort().map(function (cardId) {
    const group = grouped[cardId];
    const item = group.item || getInventoryLookupItem_(group.cardId);
    const sheetQuantity = group.sheetQuantity !== undefined ? group.sheetQuantity : item ? Number(item.quantity || 0) : 0;
    const row = {
      cardId: group.cardId,
      scannedCount: group.scannedCount,
      sheetQuantity: sheetQuantity,
      sheetDifference: group.scannedCount - sheetQuantity,
      status: getAuditSummaryStatus_(group.scannedCount, sheetQuantity, item),
      item: item,
      recordKeys: group.recordKeys
    };
    row.unscanned = !!(item && group.scannedCount === 0 && sheetQuantity > 0);
    if (row.unscanned) {
      row.status = "unscanned";
    }
    return row;
  });

  const totals = rows.reduce(function (output, row) {
    output.scannedCount += row.scannedCount;
    output.uniqueCount += 1;
    output.issueCount += row.status === "match" ? 0 : 1;
    output.sheetQuantity += row.sheetQuantity;
    output.unscannedInventoryCount += row.item && row.scannedCount === 0 && row.sheetQuantity > 0 ? 1 : 0;
    return output;
  }, {
    scannedCount: 0,
    uniqueCount: 0,
    issueCount: 0,
    sheetQuantity: 0,
    unscannedInventoryCount: 0
  });

  return {
    session: session,
    selectedSessions: selectedSessions || [session],
    generatedAt: new Date().toISOString(),
    scanCount: scans.length,
    activeScanCount: activeScans.length,
    undoneScanCount: scans.length - activeScans.length,
    totals: totals,
    rows: rows
  };
}

function getGlobalAuditSummary_(sessionIds) {
  const ids = Array.isArray(sessionIds) ? sessionIds.map(function (sessionId) {
    return String(sessionId || "").trim();
  }).filter(Boolean) : [];

  if (!ids.length) {
    throw new Error("At least one audit session is required.");
  }
  if (ids.length > 50) {
    throw new Error("Global audit review is limited to 50 sessions at a time.");
  }

  const sessions = ids.map(function (sessionId) {
    return getAuditSessionById_(sessionId);
  });
  const scans = [];
  sessions.forEach(function (session) {
    refreshAuditReviewMarkersForSession_(session, { recheckNotFound: true });
    getAuditScanRowsForSession_(session).forEach(function (scan) {
      scans.push(scan);
    });
  });

  return buildAuditSummary_({
    session_id: "global:" + ids.join(","),
    session_name: "Global audit review",
    sheet_tab_name: "",
    thread_id: "pwa-audit",
    started_at: "",
    started_by: "PWA Scanner",
    ended_at: "",
    ended_by: "",
    status: "global"
  }, scans, sessions.map(serializeAuditSession_), { includeUnscannedInventory: true });
}

function getAuditSummary_(payload) {
  const sessionIds = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
  if (sessionIds.length) {
    return getGlobalAuditSummary_(sessionIds);
  }

  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("Audit session is required.");
  }

  const session = getAuditSessionById_(sessionId);
  refreshAuditReviewMarkersForSession_(session, { recheckNotFound: true });
  const scans = getAuditScanRowsForSession_(session);
  return buildAuditSummary_(serializeAuditSession_(session), scans);
}

function getSessionById_(sessionId) {
  const sessions = getSheetRows_(CAPTURE_SESSIONS_SHEET);
  const session = sessions.filter(function (row) {
    return String(row.session_id || "").trim() === String(sessionId || "").trim();
  })[0];

  if (!session) {
    throw new Error("Capture session not found.");
  }

  return session;
}

function normalizeScanRecord_(payload, scan) {
  const timestampMs = Number(payload.sourceTimestampMs || Date.now());
  const timestamp = new Date(timestampMs);
  const quantity = Number(scan.quantity || scan.quantitySold || 1);
  const total = Number(scan.total || scan.totalAmount || scan.cost || 0);

  return {
    "Time": timestamp,
    "Product": String(scan.name || scan.product || scan.cardId || "").trim(),
    "Owner": String(scan.owner || "").trim(),
    "Category": String(scan.category || "Singles").trim(),
    "Quantity": Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    "Total": Number.isFinite(total) ? total : "",
    "Notes": [String(scan.notes || "").trim(), String(scan.parseError || "").trim()].filter(Boolean).join(" | "),
    "Card ID": String(scan.cardId || "").trim(),
    "Image Link": String(payload.imageUrl || "").trim(),
    "__record_key": String(scan.recordKey || [payload.messageId || "", scan.qrIndex || 0].join(":")).trim(),
    "__sort_key": String(timestampMs).padStart(20, "0") + ":" + String(scan.qrIndex || 0).padStart(4, "0"),
    "__message_id": String(payload.messageId || "").trim(),
    "__source_timestamp_ms": timestampMs
  };
}

function clearSalesLogDataArea_(sheet) {
  const allHeaders = SALES_LOG_HEADERS.concat(SALES_LOG_METADATA_HEADERS);
  const maxRows = sheet.getMaxRows();
  if (maxRows <= 1) {
    return;
  }
  sheet.getRange(2, 1, maxRows - 1, allHeaders.length).clearContent();
}

function findNextSalesLogWriteRow_(sheet, recordKeyColumn) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  if (lastRow < 2) {
    return 2;
  }

  if (!recordKeyColumn) {
    return 2;
  }

  const values = sheet.getRange(2, recordKeyColumn, lastRow - 1, 1).getValues();
  let lastUsedOffset = -1;
  values.forEach(function (row, index) {
    if (String(row[0] || "").trim() !== "") {
      lastUsedOffset = index;
    }
  });
  return lastUsedOffset === -1 ? 2 : lastUsedOffset + 3;
}

function recordCaptureScans_(payload) {
  const groupId = String(payload.groupId || payload.threadId || "").trim();
  const sessionId = String(payload.sessionId || "").trim();
  const scans = Array.isArray(payload.scans) ? payload.scans : [];

  if (!groupId) {
    throw new Error("groupId is required.");
  }
  if (!sessionId) {
    throw new Error("sessionId is required.");
  }
  if (!scans.length) {
    return { appended: 0, updated: 0 };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const session = getSessionById_(sessionId);
    if (String(session.group_id || "").trim() !== groupId) {
      throw new Error("Capture session does not match this group.");
    }

    const sheet = getSpreadsheet_().getSheetByName(session.sheet_tab_name);
    if (!sheet) {
      throw new Error("Missing sales log sheet: " + session.sheet_tab_name);
    }
    ensureHeaders_(sheet, SALES_LOG_HEADERS.concat(SALES_LOG_METADATA_HEADERS));

    const allHeaders = SALES_LOG_HEADERS.concat(SALES_LOG_METADATA_HEADERS);
    const headerMap = getHeaderMap_(sheet);
    const recordKeyColumn = headerMap["__record_key"];
    const existingByKey = {};
    const lastRow = sheet.getLastRow();

    if (lastRow >= 2 && recordKeyColumn) {
      const keys = sheet.getRange(2, recordKeyColumn, lastRow - 1, 1).getValues();
      keys.forEach(function (row, index) {
        const key = String(row[0] || "").trim();
        if (key) {
          existingByKey[key] = index + 2;
        }
      });
    }

    let appended = 0;
    let updated = 0;

    scans.forEach(function (scan) {
      const record = normalizeScanRecord_(payload, scan);
      const rowValues = allHeaders.map(function (header) {
        return record[header] === undefined ? "" : record[header];
      });
      const recordKey = record["__record_key"];
      const existingRow = existingByKey[recordKey];

      if (existingRow) {
        sheet.getRange(existingRow, 1, 1, allHeaders.length).setValues([rowValues]);
        updated += 1;
      } else {
        const writeRow = findNextSalesLogWriteRow_(sheet, recordKeyColumn);
        sheet.getRange(writeRow, 1, 1, allHeaders.length).setValues([rowValues]);
        existingByKey[recordKey] = writeRow;
        appended += 1;
      }
    });

    SpreadsheetApp.flush();
    return {
      appended: appended,
      updated: updated,
      sheetTabName: session.sheet_tab_name
    };
  } finally {
    lock.releaseLock();
  }
}
