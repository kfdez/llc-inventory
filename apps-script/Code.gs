const BOT_CONFIG_SHEET = "Bot Config";
const CAPTURE_SESSIONS_SHEET = "CaptureSessions";
const SALES_LOG_TEMPLATE_SHEET = "Sales Log - Template";

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

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Inventory Bot")
    .addItem("Setup Bot Sheets", "setupBotSheets")
    .addToUi();
}

function setupBotSheets() {
  getConfigSheet_();
  getCaptureSessionsSheet_();
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
