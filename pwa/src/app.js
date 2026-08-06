import { readBarcodes, setZXingModuleOverrides } from "zxing-wasm/reader";

setZXingModuleOverrides({
  locateFile: () => new URL("/zxing_reader.wasm", window.location.origin).href
});

const elements = {
  pinScreen: document.querySelector("#pinScreen"),
  scannerScreen: document.querySelector("#scannerScreen"),
  pinForm: document.querySelector("#pinForm"),
  pinInput: document.querySelector("#pinInput"),
  pinMessage: document.querySelector("#pinMessage"),
  modeMenuButton: document.querySelector("#modeMenuButton"),
  modeDrawer: document.querySelector("#modeDrawer"),
  modeBackdrop: document.querySelector("#modeBackdrop"),
  closeModeButton: document.querySelector("#closeModeButton"),
  status: document.querySelector("#status"),
  video: document.querySelector("#video"),
  cameraMessage: document.querySelector("#cameraMessage"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  lockButton: document.querySelector("#lockButton"),
  lookupModeButton: document.querySelector("#lookupModeButton"),
  cartModeButton: document.querySelector("#cartModeButton"),
  auditModeButton: document.querySelector("#auditModeButton"),
  cartBadge: document.querySelector("#cartBadge"),
  auditBadge: document.querySelector("#auditBadge"),
  cartPanel: document.querySelector("#cartPanel"),
  auditPanel: document.querySelector("#auditPanel"),
  clearCartButton: document.querySelector("#clearCartButton"),
  clearAuditLogButton: document.querySelector("#clearAuditLogButton"),
  auditControls: document.querySelector("#auditControls"),
  auditSessionForm: document.querySelector("#auditSessionForm"),
  auditSessionNameInput: document.querySelector("#auditSessionNameInput"),
  captureAuditQrButton: document.querySelector("#captureAuditQrButton"),
  stopAuditButton: document.querySelector("#stopAuditButton"),
  auditSummaryButton: document.querySelector("#auditSummaryButton"),
  globalAuditButton: document.querySelector("#globalAuditButton"),
  auditSessionText: document.querySelector("#auditSessionText"),
  auditScanCount: document.querySelector("#auditScanCount"),
  auditStatusText: document.querySelector("#auditStatusText"),
  auditSummaryPanel: document.querySelector("#auditSummaryPanel"),
  auditLog: document.querySelector("#auditLog"),
  missingNotesBackdrop: document.querySelector("#missingNotesBackdrop"),
  missingNotesModal: document.querySelector("#missingNotesModal"),
  missingNotesForm: document.querySelector("#missingNotesForm"),
  missingNotesCardId: document.querySelector("#missingNotesCardId"),
  missingNotesInput: document.querySelector("#missingNotesInput"),
  missingNotesSkipButton: document.querySelector("#missingNotesSkipButton"),
  globalAuditBackdrop: document.querySelector("#globalAuditBackdrop"),
  globalAuditModal: document.querySelector("#globalAuditModal"),
  globalAuditModalContent: document.querySelector("#globalAuditModalContent"),
  cacheStatusText: document.querySelector("#cacheStatusText"),
  decodedPanel: document.querySelector("#decodedPanel"),
  decodedValue: document.querySelector("#decodedValue"),
  scanCanvas: document.querySelector("#scanCanvas")
};

function storageGet(storage, key, fallback = "") {
  try {
    const value = storage.getItem(key);
    return value == null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function storageSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch (_) {}
}

function storageRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch (_) {}
}

function readJsonStorage(key, fallback) {
  const durableValue = storageGet(localStorage, key, "");
  const raw = durableValue || storageGet(sessionStorage, key, "");
  if (!raw) return fallback;
  if (!durableValue) storageSet(localStorage, key, raw);
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function readNumberStorage(key, fallback = 0) {
  const durableValue = storageGet(localStorage, key, "");
  const raw = durableValue || storageGet(sessionStorage, key, "");
  if (!durableValue && raw) storageSet(localStorage, key, raw);
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const storedMode = storageGet(localStorage, "scannerMode", storageGet(sessionStorage, "scannerMode", ""));
if (storedMode && !storageGet(localStorage, "scannerMode", "")) {
  storageSet(localStorage, "scannerMode", storedMode);
}

let pin = storageGet(sessionStorage, "scannerPin", "");
let stream = null;
let scanning = false;
let scanPaused = false;
let lookupInProgress = false;
let lookupQueue = [];
let lastCode = "";
let missedScanFrames = 0;
let mode = ["lookup", "cart", "audit"].includes(storedMode) ? storedMode : "lookup";
let cart = readJsonStorage("scannerCart", []);
let auditSession = readJsonStorage("auditSession", null);
let auditScanCount = readNumberStorage("auditScanCount", 0);
let auditLog = readJsonStorage("auditLog", []);
let auditSummary = readJsonStorage("auditSummary", null);
let lastAuditReviewSessionId = storageGet(localStorage, "lastAuditReviewSessionId", "");
if (!Array.isArray(cart)) cart = [];
if (!Array.isArray(auditLog)) auditLog = [];
let auditSummaryLoadVersion = 0;
let auditCollectrSyncAllRunning = false;
let auditCollectrSyncAllStopRequested = false;
let auditCollectrSyncJobId = storageGet(localStorage, "auditCollectrSyncJobId", "");
let auditCollectrSyncAllTotal = 0;
let auditCollectrSyncAllCompleted = 0;
let auditCollectrSyncAllFailed = 0;
let auditCollectrSyncAllRetry = 0;
let auditCaptureFeedbackTimer = 0;
let missingNotesRecordKey = "";
const auditLookupRecordKeys = new Set();
auditLog = auditLog.map((entry) => {
  if (entry.status === "syncing") return { ...entry, status: "pending", message: "Queued" };
  if (entry.status === "undoing") return { ...entry, status: "synced", message: "Synced" };
  return entry;
});
let auditSaveRunning = false;
let pendingAuditRawValue = "";
let pendingAuditCardId = "";
let lastStatusError = "";
let currentLookupItem = null;
let audioContext = null;
let stickerSaveQueue = [];
let stickerSyncRunning = false;
let stickerSyncError = "";
let stickerSyncMessage = "";
const scanContext = elements.scanCanvas.getContext("2d", { willReadFrequently: true });

function setStatus(text, kind = "") {
  if (kind !== "error") {
    lastStatusError = "";
  }
  elements.status.textContent = text;
  elements.status.className = "pill " + kind;
  elements.status.title = kind === "error" && lastStatusError ? "Tap for error details" : "";
  elements.status.style.cursor = kind === "error" && lastStatusError ? "pointer" : "";
}

function setErrorStatus(text, message) {
  lastStatusError = String(message || text || "");
  setStatus(text, "error");
}

async function readApiJson(response, fallbackMessage) {
  const text = await response.text();
  try {
    return JSON.parse(text || "{}");
  } catch (_) {
    throw new Error(
      fallbackMessage + ": HTTP " + response.status +
      ", content-type " + (response.headers.get("content-type") || "unknown") +
      ", body " + text.replace(/\s+/g, " ").slice(0, 160)
    );
  }
}

function clearStatusError() {
  lastStatusError = "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authenticatedFetch(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;
  const headers = { ...(fetchOptions.headers || {}), "X-App-Pin": pin };
  if (!timeoutMs) {
    return fetch(url, { ...fetchOptions, headers });
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...fetchOptions, headers, signal: controller.signal }).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function compactDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m";
  return Math.round(minutes / 60) + "h";
}

function renderCacheStatus(cache) {
  if (!elements.cacheStatusText) return;
  if (!cache) {
    elements.cacheStatusText.textContent = "";
    return;
  }
  if (!cache.loaded) {
    if (cache.lastError) {
      elements.cacheStatusText.textContent = "Inventory cache failed: " + cache.lastError;
    } else {
      elements.cacheStatusText.textContent = cache.loading
        ? "Inventory cache warming..."
        : "Inventory cache not loaded";
    }
    return;
  }
  const age = cache.ageMs == null ? "" : " · " + compactDuration(cache.ageMs) + " old";
  const duplicates = cache.duplicateIdCount ? " · " + cache.duplicateIdCount + " duplicate IDs" : "";
  elements.cacheStatusText.textContent = "Inventory cache: " + Number(cache.itemCount || 0).toLocaleString("en-CA") + " IDs · " + cache.state + age + duplicates;
}

async function refreshCacheStatus(options = {}) {
  if (!pin) return;
  const query = options.warm ? "?warm=1" : "";
  try {
    const response = await authenticatedFetch("/api/cache-status" + query);
    const data = await response.json();
    if (response.status === 401) {
      lock();
      return;
    }
    if (!response.ok || !data.ok) throw new Error(data.error || "Unable to load cache status.");
    renderCacheStatus(data.cache);
  } catch (error) {
    if (elements.cacheStatusText) {
      elements.cacheStatusText.textContent = "Inventory cache status unavailable: " + error.message;
    }
  }
}

async function unlock(candidatePin) {
  const response = await fetch("/api/session", { headers: { "X-App-Pin": candidatePin } });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "Unable to unlock scanner.");
  pin = candidatePin;
  storageSet(sessionStorage, "scannerPin", pin);
  elements.pinScreen.hidden = true;
  elements.scannerScreen.hidden = false;
  elements.pinMessage.textContent = "";
  await resumeAuditSessionFromServer();
  recoverCheckingAuditScans();
  if (auditLog.some((entry) => entry.status === "pending" || entry.status === "syncing")) {
    void drainAuditSaveQueue();
  }
  void refreshCacheStatus({ warm: true });
  window.setTimeout(() => { void refreshCacheStatus(); }, 3000);
  window.setTimeout(() => { void refreshCacheStatus(); }, 8000);
}

function lock() {
  stopCamera();
  lookupQueue = [];
  pin = "";
  storageRemove(sessionStorage, "scannerPin");
  elements.pinInput.value = "";
  elements.pinScreen.hidden = false;
  elements.scannerScreen.hidden = true;
  renderCacheStatus(null);
  setStatus("Locked");
}

function money(value) {
  if (value === "" || value === null || value === undefined) return "—";
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(number)
    : String(value);
}

function numericPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function selectablePrice(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(String(value).replace(/[$,]/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function escapeHtml(value) {
  const span = document.createElement("span");
  span.textContent = String(value);
  return span.innerHTML;
}

function renderItem(cardId, item) {
  currentLookupItem = item;
  document.querySelector("#emptyState").hidden = true;
  document.querySelector("#resultContent").hidden = false;
  document.querySelector("#result").classList.remove("empty");
  document.querySelector("#resultName").textContent = item.name || "Unnamed card";
  document.querySelector("#resultSet").textContent = item.setName || item.category || "Inventory match";
  document.querySelector("#resultMeta").textContent = [item.cardNumber, item.variance, item.grade, item.condition].filter(Boolean).join(" · ");
  document.querySelector("#resultId").textContent = cardId;
  document.querySelector("#marketPrice").textContent = money(item.marketPrice);
  document.querySelector("#suggestedPrice").textContent = money(item.suggestedPrice);
  document.querySelector("#marketPriceOption").disabled = selectablePrice(item.marketPrice) === null;
  document.querySelector("#suggestedPriceOption").disabled = selectablePrice(item.suggestedPrice) === null;
  const blankStickeredPrice = item.stickeredPrice === "" || item.stickeredPrice == null;
  document.querySelector("#stickeredPriceInput").value = blankStickeredPrice ? "0" : item.stickeredPrice;
  document.querySelector("#stickerPortfolioText").textContent = "Portfolio: " + (item.portfolioName || "Not specified");
  document.querySelector("#lastStickeredText").textContent = item.lastStickered
    ? "Last stickered: " + new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.lastStickered))
    : "Not stickered yet";
  const detailValues = { Condition: item.condition, Portfolio: item.portfolioName, Category: item.category, "Sheet tab": item.sheetName };
  document.querySelector("#details").innerHTML = Object.entries(detailValues)
    .filter(([, value]) => value !== "" && value != null)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
  document.querySelector("#allFields").innerHTML = Object.entries(item.fields || {})
    .filter(([, value]) => value !== "" && value != null)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

async function loadStickerTargets(cardId, item) {
  const list = document.querySelector("#stickerTargetsList");
  list.textContent = "Checking matching portfolios…";
  try {
    const query = new URLSearchParams({ cardId, sheetName: item.sheetName || "", rowNumber: String(item.rowNumber || "") });
    const response = await authenticatedFetch("/api/sticker-targets?" + query.toString());
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Unable to load matching portfolios.");
    if (document.querySelector("#resultId").textContent.trim() !== cardId) return;
    list.innerHTML = (data.portfolios || []).map((portfolio) =>
      `<span class="target-chip"><strong>${escapeHtml(portfolio.name)}</strong><small>Qty ${escapeHtml(portfolio.quantity)}${portfolio.rowCount > 1 ? " · " + portfolio.rowCount + " rows" : ""}</small></span>`
    ).join("") || "No matching portfolios found";
  } catch (error) {
    if (document.querySelector("#resultId").textContent.trim() === cardId) list.textContent = error.message;
  }
}

function signalQrDetection() {
  if (typeof navigator.vibrate === "function" && navigator.vibrate(60)) return;
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.08, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.07);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.07);
}

function saveCart() {
  storageSet(localStorage, "scannerCart", JSON.stringify(cart));
}

function cartQuantity() {
  return cart.reduce((total, entry) => total + entry.quantity, 0);
}

function renderCart() {
  const quantity = cartQuantity();
  elements.cartBadge.textContent = quantity;
  document.querySelector("#cartEmpty").hidden = cart.length > 0;
  document.querySelector("#cartContent").hidden = cart.length === 0;
  document.querySelector("#cartItemCount").textContent = quantity;
  document.querySelector("#cartTotal").textContent = money(cart.reduce((total, entry) => total + numericPrice(entry.marketPrice) * entry.quantity, 0));
  document.querySelector("#cartItems").innerHTML = cart.map((entry) => {
    const subtitle = [entry.setName, entry.cardNumber, entry.variance].filter(Boolean).join(" · ");
    return `<div class="cart-item" data-card-id="${escapeHtml(entry.cardId)}">
      <div class="cart-item-copy"><strong>${escapeHtml(entry.name || "Unnamed card")}</strong><span>${escapeHtml(subtitle || entry.cardId)}</span></div>
      <div class="cart-item-price"><strong>${escapeHtml(money(numericPrice(entry.marketPrice) * entry.quantity))}</strong><span>${escapeHtml(money(entry.marketPrice))} each</span></div>
      <div class="quantity-controls">
        <button type="button" data-action="decrease" aria-label="Decrease ${escapeHtml(entry.name || entry.cardId)}">−</button>
        <span>${entry.quantity}</span>
        <button type="button" data-action="increase" aria-label="Increase ${escapeHtml(entry.name || entry.cardId)}">+</button>
      </div>
    </div>`;
  }).join("");
}

function saveAuditState() {
  storageSet(localStorage, "auditSession", JSON.stringify(auditSession));
  storageSet(localStorage, "auditScanCount", String(auditScanCount));
  storageSet(localStorage, "auditLog", JSON.stringify(auditLog));
  storageSet(localStorage, "auditSummary", JSON.stringify(auditSummary));
  storageSet(localStorage, "lastAuditReviewSessionId", lastAuditReviewSessionId);
  storageRemove(localStorage, "auditCollectrJobId");
}

function auditStatusLabel(status) {
  return {
    "match": "Match",
    "short": "Short",
    "over": "Over",
    "not-in-sheet": "Not in sheet",
    "unscanned": "Unscanned",
    "collectr-error": "Collectr issue"
  }[status] || "Issue";
}

function getAuditReviewRowStatus(row) {
  if (!row.item) return "not-in-sheet";
  if (row.collectrError) return "collectr-error";
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

function recomputeAuditSummaryTotals() {
  if (!auditSummary || !Array.isArray(auditSummary.rows)) return;
  const rows = auditSummary.rows;
  auditSummary.totals = rows.reduce((output, row) => {
    output.scannedCount += Number(row.scannedCount || 0);
    output.uniqueCount += 1;
    output.issueCount += row.status === "match" ? 0 : 1;
    output.sheetQuantity += Number(row.sheetQuantity || 0);
    output.collectrQuantity += row.collectrLoaded && !row.collectrError ? Number(row.collectrQuantity || 0) : 0;
    return output;
  }, {
    scannedCount: 0,
    uniqueCount: 0,
    issueCount: 0,
    sheetQuantity: 0,
    collectrQuantity: 0
  });
  const collectrRows = rows.filter((row) => row.item);
  const pendingRows = collectrRows.filter((row) => !row.collectrLoaded && !row.collectrError);
  auditSummary.collectr = {
    ...(auditSummary.collectr || {}),
    loadedCount: collectrRows.length - pendingRows.length,
    pendingCount: pendingRows.length
  };
}

function isAuditReviewRowSyncable(row) {
  if (!row || !row.item || row.collectrSyncing) return false;
  if (row.collectrSyncSkipped) return false;
  const targetQuantity = Number(row.scannedCount || 0);
  if (!Number.isInteger(targetQuantity) || targetQuantity < 0) return false;
  if (row.collectrLoaded && row.collectrQuantity !== null && row.collectrQuantity !== undefined) {
    return Number(row.collectrQuantity || 0) !== targetQuantity;
  }
  return Boolean(
    row.item.collectrProductId ||
    (row.item.setName && row.item.name && row.item.cardNumber)
  );
}

function getSyncableAuditReviewRows() {
  if (!auditSummary || !Array.isArray(auditSummary.rows)) return [];
  return auditSummary.rows.filter(isAuditReviewRowSyncable);
}

function getAuditSyncAllText() {
  if (!auditCollectrSyncAllRunning) {
    const syncableRows = getSyncableAuditReviewRows();
    return syncableRows.length + " Collectr update" + (syncableRows.length === 1 ? "" : "s") + " ready";
  }
  if (auditCollectrSyncAllStopRequested) return "Stopping sync all after current item";
  const processed = auditCollectrSyncAllCompleted + auditCollectrSyncAllFailed;
  return "Sync all running " + processed + "/" + auditCollectrSyncAllTotal + " processed | " +
    auditCollectrSyncAllCompleted + " synced" +
    (auditCollectrSyncAllFailed ? " | " + auditCollectrSyncAllFailed + " failed" : "") +
    (auditCollectrSyncAllRetry ? " | " + auditCollectrSyncAllRetry + " waiting" : "");
}

function renderAuditSyncProgress() {
  const progress = elements.auditSummaryPanel.querySelector("[data-audit-sync-progress]");
  if (!progress) return;
  const text = progress.querySelector("[data-audit-sync-text]");
  const fill = progress.querySelector("[data-audit-sync-fill]");
  if (text) text.textContent = getAuditSyncAllText();
  if (fill) {
    const processed = auditCollectrSyncAllCompleted + auditCollectrSyncAllFailed;
    const percent = auditCollectrSyncAllTotal ? Math.min(100, Math.round(processed / auditCollectrSyncAllTotal * 100)) : 0;
    fill.style.width = percent + "%";
  }
}

function renderAuditSummary() {
  if (!auditSummary) {
    elements.auditSummaryPanel.hidden = true;
    elements.auditSummaryPanel.innerHTML = "";
    return;
  }
  const totals = auditSummary.totals || {};
  const rows = Array.isArray(auditSummary.rows) ? auditSummary.rows : [];
  const issueRows = rows.filter((row) => row.status !== "match");
  const visibleRows = issueRows.concat(rows.filter((row) => row.status === "match"));
  const syncableRows = getSyncableAuditReviewRows();
  const selectedSessions = Array.isArray(auditSummary.selectedSessions) ? auditSummary.selectedSessions : [];
  elements.auditSummaryPanel.hidden = false;
  elements.auditSummaryPanel.innerHTML = `<div class="audit-review-totals">
    <div><span>Unique</span><strong>${Number(totals.uniqueCount || 0)}</strong></div>
    <div><span>Issues</span><strong>${Number(totals.issueCount || 0)}</strong></div>
    <div><span>Sheet qty</span><strong>${Number(totals.sheetQuantity || 0)}</strong></div>
    <div><span>Collectr qty</span><strong>${Number(totals.collectrQuantity || 0)}</strong></div>
  </div>
  ${selectedSessions.length > 1 ? `<div class="audit-review-context">${selectedSessions.length} locations combined: ${escapeHtml(selectedSessions.map((session) => session.session_name).join(", "))}</div>` : ""}
  ${syncableRows.length || auditCollectrSyncAllRunning ? `<div class="audit-review-progress audit-review-bulk" data-audit-sync-progress><div class="audit-review-progress-copy"><span data-audit-sync-text>${escapeHtml(getAuditSyncAllText())}</span>${auditCollectrSyncAllRunning ? `<div class="audit-review-progress-bar"><i data-audit-sync-fill style="width: ${auditCollectrSyncAllTotal ? Math.min(100, Math.round((auditCollectrSyncAllCompleted + auditCollectrSyncAllFailed) / auditCollectrSyncAllTotal * 100)) : 0}%"></i></div>` : ""}</div>${auditCollectrSyncAllRunning ? `<button type="button" class="secondary compact-button" data-audit-action="stop-sync-all-collectr" ${auditCollectrSyncAllStopRequested ? "disabled" : ""}>Stop</button>` : syncableRows.length ? `<button type="button" class="secondary compact-button" data-audit-action="sync-all-collectr">Sync all</button>` : ""}</div>` : ""}
  <div class="audit-review-list">
    ${visibleRows.length ? visibleRows.map((row) => {
      const item = row.item || {};
      const title = item.name || row.cardId || "Unknown card";
      const meta = [item.portfolioName || row.collectrPortfolioName, item.setName, item.cardNumber].filter(Boolean).join(" | ");
      const collectrText = !row.item
        ? "Collectr skipped"
        : row.collectrSyncing
          ? "Collectr syncing"
          : row.collectrError
          ? "Collectr: " + row.collectrError
          : row.collectrSyncStatus
            ? row.collectrSyncStatus
          : row.collectrLoaded
            ? "Collectr " + (row.collectrQuantity ?? "-")
            : isAuditReviewRowSyncable(row)
              ? "Collectr ready"
              : "Collectr pending";
      const canAdjustCollectr = isAuditReviewRowSyncable(row) && !row.collectrSyncing;
      const rowClass = [
        "audit-review-row",
        row.status === "match" ? "" : "issue",
        row.collectrError ? "error" : "",
        row.collectrSyncing ? "syncing" : ""
      ].filter(Boolean).join(" ");
      return `<div class="${rowClass}" data-card-id="${escapeHtml(row.cardId)}">
        <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta || row.cardId)}</span></div>
        <div class="audit-review-counts"><span>Scanned ${Number(row.scannedCount || 0)}</span><span>Sheet ${Number(row.sheetQuantity || 0)}</span><span>${escapeHtml(collectrText)}</span></div>
        <div class="audit-review-actions"><b>${escapeHtml(auditStatusLabel(row.status))}</b>${canAdjustCollectr ? `<button type="button" class="secondary compact-button" data-audit-action="adjust-collectr" data-card-id="${escapeHtml(row.cardId)}" data-target-quantity="${Number(row.scannedCount || 0)}">Set Collectr</button>` : ""}</div>
      </div>`;
    }).join("") : `<div class="audit-review-empty">No scans recorded for this session.</div>`}
  </div>`;
}

function renderAuditState() {
  elements.auditBadge.textContent = auditScanCount;
  elements.auditScanCount.textContent = auditScanCount;
  elements.auditStatusText.textContent = auditSession ? "Active" : "Inactive";
  elements.stopAuditButton.disabled = !auditSession;
  elements.auditSummaryButton.disabled = !auditSession && !(auditSummary && auditSummary.session) && !lastAuditReviewSessionId;
  elements.captureAuditQrButton.disabled = !auditSession || !pendingAuditCardId;
  elements.auditSessionText.textContent = auditSession
    ? "Active: " + auditSession.session_name + " -> " + auditSession.sheet_tab_name
    : "No active audit session.";
  elements.auditLog.className = auditLog.length ? "audit-log" : "audit-log empty";
  const pendingCount = auditLog.filter((entry) => entry.status === "pending" || entry.status === "syncing").length;
  if (auditSession) {
    elements.auditStatusText.textContent = pendingCount ? pendingCount + " queued" : "Active";
  } else {
    elements.auditStatusText.textContent = "Inactive";
  }
  elements.auditLog.innerHTML = auditLog.length
    ? auditLog.slice(0, 60).map((entry) => {
      const subtitle = [entry.setName, entry.cardId, entry.status || "pending"].filter(Boolean).join(" | ");
      const canCancel = entry.status === "pending";
      const canUndo = entry.status === "synced";
      const canRetry = entry.status === "error" || entry.status === "undo_error";
      const needsNotes = entry.status === "needs_notes";
      const canEditNotes = entry.kind === "issue" && (entry.status === "needs_notes" || entry.status === "pending");
      return `<div class="audit-entry ${entry.kind || ""}">
        <div class="audit-entry-copy"><strong>${escapeHtml(entry.name || "Unknown card")}</strong><small>${escapeHtml(subtitle)}</small></div>
        <span>${escapeHtml(entry.message || "Recorded")}</span>
        <div class="audit-entry-actions">
          ${canCancel ? `<button type="button" class="secondary compact-button" data-audit-action="cancel" data-record-key="${escapeHtml(entry.recordKey)}">Cancel</button>` : ""}
          ${canUndo ? `<button type="button" class="secondary compact-button" data-audit-action="undo" data-record-key="${escapeHtml(entry.recordKey)}">Undo</button>` : ""}
          ${canRetry ? `<button type="button" class="secondary compact-button" data-audit-action="retry" data-record-key="${escapeHtml(entry.recordKey)}">Retry</button>` : ""}
          ${canEditNotes ? `<button type="button" class="secondary compact-button" data-audit-action="notes" data-record-key="${escapeHtml(entry.recordKey)}">${needsNotes ? "Notes" : "Edit notes"}</button>` : ""}
          ${needsNotes ? `<button type="button" class="secondary compact-button" data-audit-action="queue-missing" data-record-key="${escapeHtml(entry.recordKey)}">Queue</button>` : ""}
        </div>
        ${needsNotes ? `<form class="audit-entry-notes" data-record-key="${escapeHtml(entry.recordKey)}"><input name="notes" value="${escapeHtml(entry.notes || "")}" placeholder="Add notes for this missing ID"><button type="submit" class="secondary compact-button">Save notes</button></form>` : ""}
      </div>`;
    }).join("")
    : "Start an audit session and scan labels.";
  renderAuditSummary();
}

function buildAuditEntryFromServerScan(session, scan) {
  const cardId = String(scan.cardId || "").trim();
  return {
    recordKey: String(scan.recordKey || [session.session_id, cardId, scan.scannedAt || ""].join(":")),
    sessionId: session.session_id,
    cardId,
    name: cardId,
    setName: "",
    attempts: 0,
    status: "synced",
    kind: "",
    message: "Synced"
  };
}

function mergeAuditScansFromServer(session, scans) {
  const existingByKey = new Map(auditLog.map((entry) => [entry.recordKey, entry]));
  const serverEntries = (Array.isArray(scans) ? scans : [])
    .filter((scan) => scan && scan.cardId)
    .map((scan) => {
      const incoming = buildAuditEntryFromServerScan(session, scan);
      const existing = existingByKey.get(incoming.recordKey);
      if (!existing) return incoming;
      if (existing.status === "pending" || existing.status === "syncing") return existing;
      return {
        ...incoming,
        ...existing,
        status: "synced",
        message: existing.message || "Synced"
      };
    });
  const serverKeys = new Set(serverEntries.map((entry) => entry.recordKey));
  const localCarryover = auditLog.filter((entry) => {
    if (entry.sessionId !== session.session_id) return false;
    if (serverKeys.has(entry.recordKey)) return false;
    return entry.status === "pending" || entry.status === "syncing" || entry.status === "error" || entry.status === "undo_error";
  });

  auditLog = localCarryover.concat(serverEntries).slice(0, 250);
  auditScanCount = auditLog.filter((entry) => entry.status !== "undoing" && entry.status !== "undo_error").length;
}

async function resumeAuditSessionFromServer() {
  if (!pin) return;
  try {
    const response = await authenticatedFetch("/api/audit/status");
    const data = await response.json();
    if (response.status === 401) {
      lock();
      return;
    }
    if (!response.ok || !data.ok) throw new Error(data.error || "Unable to load audit status.");
    if (!data.session) return;

    const hadDifferentSession = !auditSession || auditSession.session_id !== data.session.session_id;
    auditSession = data.session;
    auditSummary = hadDifferentSession ? null : auditSummary;
    mergeAuditScansFromServer(auditSession, data.scans);
    saveAuditState();
    setMode("audit");
    renderAuditState();
    if (hadDifferentSession) {
      setStatus("Audit restored", "success");
      elements.cameraMessage.textContent = "Active audit restored from the sheet.";
    }
  } catch (error) {
    setErrorStatus("Audit restore issue", error.message);
  }
}

function addAuditLogEntry(entry) {
  auditLog.unshift(entry);
  saveAuditState();
  renderAuditState();
}

function updateAuditLogEntry(recordKey, patch) {
  auditLog = auditLog.map((entry) => entry.recordKey === recordKey ? { ...entry, ...patch } : entry);
  saveAuditState();
  renderAuditState();
}

function setPendingAuditQr(rawValue) {
  pendingAuditRawValue = String(rawValue || "").trim();
  pendingAuditCardId = extractCardId(pendingAuditRawValue);
  elements.captureAuditQrButton.disabled = !auditSession || !pendingAuditCardId;
  if (pendingAuditCardId) {
    if (!auditCaptureFeedbackTimer) {
      elements.captureAuditQrButton.classList.remove("captured");
      elements.captureAuditQrButton.textContent = "Capture QR";
    }
    elements.decodedValue.textContent = pendingAuditRawValue;
    elements.decodedPanel.hidden = false;
    clearStatusError();
    setStatus("QR ready", "success");
    elements.cameraMessage.textContent = "QR detected. Tap Capture QR to add it to the audit queue.";
  } else {
    elements.captureAuditQrButton.classList.remove("captured");
    elements.captureAuditQrButton.textContent = "Capture QR";
  }
}

function showAuditCaptureFeedback() {
  if (auditCaptureFeedbackTimer) {
    window.clearTimeout(auditCaptureFeedbackTimer);
  }
  elements.captureAuditQrButton.classList.add("captured");
  elements.captureAuditQrButton.textContent = "Captured";
  elements.captureAuditQrButton.disabled = true;
  auditCaptureFeedbackTimer = window.setTimeout(() => {
    auditCaptureFeedbackTimer = 0;
    elements.captureAuditQrButton.classList.remove("captured");
    elements.captureAuditQrButton.textContent = "Capture QR";
    elements.captureAuditQrButton.disabled = !auditSession || !pendingAuditCardId;
  }, 900);
}

async function startAuditSession(sessionName) {
  const response = await fetch("/api/audit/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Pin": pin },
    body: JSON.stringify({ sessionName })
  });
  const data = await response.json();
  if (response.status === 401) {
    lock();
    throw new Error("Scanner PIN expired. Unlock the app again.");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || "Unable to start audit.");
  auditSession = data.session;
  auditScanCount = 0;
  auditLog = [];
  auditSummary = null;
  lastAuditReviewSessionId = auditSession.session_id;
  saveAuditState();
  renderAuditState();
}

async function stopAuditSession() {
  const response = await fetch("/api/audit/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Pin": pin },
    body: "{}"
  });
  const data = await response.json();
  if (response.status === 401) {
    lock();
    throw new Error("Scanner PIN expired. Unlock the app again.");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || "Unable to stop audit.");
  auditSession = null;
  saveAuditState();
  renderAuditState();
}

async function loadAuditSummary(sessionId) {
  const normalizedSessionId = String(sessionId || auditSession && auditSession.session_id || auditSummary && auditSummary.session && auditSummary.session.session_id || lastAuditReviewSessionId || "").trim();
  if (!normalizedSessionId) throw new Error("Audit session is required.");
  cancelAuditCollectrLoading({ render: false });
  const loadVersion = auditSummaryLoadVersion + 1;
  auditSummaryLoadVersion = loadVersion;
  lastAuditReviewSessionId = normalizedSessionId;
  auditSummary = null;
  saveAuditState();
  renderAuditState();
  elements.auditSummaryPanel.hidden = false;
  elements.auditSummaryPanel.innerHTML = `<div class="audit-review-empty">Loading audit review...</div>`;
  const response = await fetch("/api/audit/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Pin": pin },
    body: JSON.stringify({ sessionId: normalizedSessionId })
  });
  const data = await response.json();
  if (response.status === 401) {
    lock();
    throw new Error("Scanner PIN expired. Unlock the app again.");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || "Unable to load audit summary.");
  if (loadVersion !== auditSummaryLoadVersion) return auditSummary;
  auditSummary = data.summary;
  recomputeAuditSummaryTotals();
  saveAuditState();
  renderAuditState();
  return auditSummary;
}

async function loadGlobalAuditSessions() {
  openGlobalAuditModal(`<div class="audit-review-empty">Loading audit sessions...</div>`);
  const response = await authenticatedFetch("/api/audit/sessions?limit=50");
  const data = await response.json();
  if (response.status === 401) {
    lock();
    throw new Error("Scanner PIN expired. Unlock the app again.");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || "Unable to load audit sessions.");
  renderGlobalAuditSessionPicker(Array.isArray(data.sessions) ? data.sessions : []);
}

function openGlobalAuditModal(content) {
  elements.globalAuditModalContent.innerHTML = content || "";
  elements.globalAuditBackdrop.hidden = false;
  elements.globalAuditModal.hidden = false;
}

function closeGlobalAuditModal() {
  elements.globalAuditBackdrop.hidden = true;
  elements.globalAuditModal.hidden = true;
  elements.globalAuditModalContent.innerHTML = "";
}

function renderGlobalAuditSessionPicker(sessions) {
  const rows = sessions.filter((session) => Number(session.activeScanCount || 0) > 0);
  openGlobalAuditModal(`<form class="audit-session-picker" id="globalAuditSessionForm">
    <div class="audit-picker-heading">
      <div><strong id="globalAuditTitle">Global audit review</strong><span>Select every binder or box that should count toward total inventory.</span></div>
      <button type="button" class="secondary compact-button" data-global-audit-action="close">Close</button>
    </div>
    <div class="audit-picker-toolbar">
      <button type="submit" class="secondary compact-button" ${rows.length ? "" : "disabled"}>Review selected</button>
    </div>
    <div class="audit-session-list">
      ${rows.length ? rows.map((session, index) => {
        const checked = index < Math.min(rows.length, 12) ? "checked" : "";
        const meta = [session.status || "", Number(session.activeScanCount || 0) + " scans"].filter(Boolean).join(" | ");
        return `<label class="audit-session-option">
          <input type="checkbox" name="sessionId" value="${escapeHtml(session.session_id)}" ${checked}>
          <span><strong>${escapeHtml(session.session_name || session.session_id)}</strong><small>${escapeHtml(meta)}</small></span>
        </label>`;
      }).join("") : `<div class="audit-review-empty">No audit sessions with scans found.</div>`}
    </div>
  </form>`);
}

function renderGlobalAuditLoading(selectedCount) {
  elements.auditSummaryPanel.hidden = false;
  elements.auditSummaryPanel.innerHTML = `<div class="audit-loading">
    <div class="audit-loading-copy">
      <strong>Loading selected sessions</strong>
      <span>${Number(selectedCount || 0)} session${Number(selectedCount || 0) === 1 ? "" : "s"} selected. Combining scans and comparing against sheet inventory.</span>
    </div>
    <div class="audit-loading-bar"><span></span></div>
  </div>`;
}

async function loadGlobalAuditSummary(sessionIds) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : []).map((sessionId) => String(sessionId || "").trim()).filter(Boolean);
  if (!ids.length) throw new Error("Select at least one audit session.");
  cancelAuditCollectrLoading({ render: false });
  const loadVersion = auditSummaryLoadVersion + 1;
  auditSummaryLoadVersion = loadVersion;
  lastAuditReviewSessionId = "global:" + ids.join(",");
  auditSummary = null;
  saveAuditState();
  renderAuditState();
  renderGlobalAuditLoading(ids.length);
  const response = await fetch("/api/audit/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Pin": pin },
    body: JSON.stringify({ sessionIds: ids })
  });
  const data = await response.json();
  if (response.status === 401) {
    lock();
    throw new Error("Scanner PIN expired. Unlock the app again.");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || "Unable to load global audit summary.");
  if (loadVersion !== auditSummaryLoadVersion) return auditSummary;
  auditSummary = data.summary;
  recomputeAuditSummaryTotals();
  saveAuditState();
  renderAuditState();
  return auditSummary;
}

function cancelAuditCollectrLoading(options = {}) {
  auditSummaryLoadVersion += 1;
  if ((options.render !== false) && auditSummary) {
    recomputeAuditSummaryTotals();
    saveAuditState();
    renderAuditState();
  }
}

function updateAuditReviewRow(cardId, patch, options = {}) {
  if (!auditSummary || !Array.isArray(auditSummary.rows)) return;
  const key = String(cardId || "").toUpperCase();
  auditSummary.rows = auditSummary.rows.map((row) => {
    if (String(row.cardId || "").toUpperCase() !== key) return row;
    const updated = { ...row, ...patch };
    updated.status = getAuditReviewRowStatus(updated);
    return updated;
  });
  recomputeAuditSummaryTotals();
  saveAuditState();
  if (options.render !== false) renderAuditState();
}

function getAuditSummaryRow(cardId) {
  if (!auditSummary || !Array.isArray(auditSummary.rows)) return null;
  const key = String(cardId || "").toUpperCase();
  return auditSummary.rows.find((row) => String(row.cardId || "").toUpperCase() === key) || null;
}

function applyAuditCollectrSyncSuccess(cardId, targetQuantity, data, options = {}) {
  const result = data && data.result || {};
  const collectr = result.collectr || {};
  const currentQuantity = Number(collectr.currentQuantity ?? targetQuantity);
  updateAuditReviewRow(cardId, {
    collectrLoaded: true,
    collectrPending: false,
    collectrSyncing: false,
    collectrError: "",
    collectrQuantity: currentQuantity,
    collectrDifference: Number(targetQuantity || 0) - currentQuantity,
    collectrPortfolioName: result.portfolio && result.portfolio.name || "",
    collectrProductId: result.product && result.product.id || "",
    collectrSyncStatus: "Collectr updated to " + currentQuantity
  }, options);
}

function applyAuditCollectrSyncError(cardId, message, options = {}) {
  updateAuditReviewRow(cardId, {
    collectrPending: false,
    collectrSyncing: false,
    collectrSyncSkipped: Boolean(options.skipped),
    collectrError: message,
    collectrSyncStatus: ""
  }, options);
}

function compactAuditCollectrSyncJobRow(row) {
  const compact = compactAuditCollectrJobRow(row);
  return {
    ...compact,
    targetQuantity: Number(row.scannedCount || 0),
    collectrQuantity: Number(row.collectrQuantity || 0),
    collectrPortfolioName: row.collectrPortfolioName || "",
    collectrProductId: row.collectrProductId || "",
    collectrSubType: row.collectrSubType || "",
    collectrGradeId: row.collectrGradeId || "",
    collectrUserOwnedProductId: row.collectrUserOwnedProductId || ""
  };
}

function mergeAuditCollectrSyncRows(rows, options = {}) {
  if (!auditSummary || !Array.isArray(auditSummary.rows)) return;
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = String(row.status || "");
    if (status === "synced") {
      applyAuditCollectrSyncSuccess(row.cardId, row.targetQuantity, {
        result: {
          portfolio: { name: row.collectrPortfolioName || "" },
          product: { id: row.collectrProductId || "" },
          collectr: { currentQuantity: Number(row.collectrQuantity || row.targetQuantity || 0) }
        }
      }, { render: false });
    } else if (status === "failed") {
      applyAuditCollectrSyncError(row.cardId, row.error || "Collectr sync failed.", { skipped: true, render: false });
    } else if (status === "retry") {
      updateAuditReviewRow(row.cardId, {
        collectrSyncing: true,
        collectrSyncStatus: "Collectr retry queued" + (row.attempts ? " (" + row.attempts + "/3)" : ""),
        collectrError: row.error || ""
      }, { render: false });
    }
  }
  recomputeAuditSummaryTotals();
  saveAuditState();
  if (options.render !== false) renderAuditState();
}

function releasePendingAuditCollectrSyncRows(rows, message) {
  if (!auditSummary || !Array.isArray(auditSummary.rows)) return;
  const completed = new Set();
  for (const row of Array.isArray(auditSummary.rows) ? auditSummary.rows : []) {
    if (!row.collectrSyncing) completed.add(String(row.cardId || "").toUpperCase());
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row.cardId || "").toUpperCase();
    const current = getAuditSummaryRow(key);
    if (!current || !current.collectrSyncing || completed.has(key)) continue;
    updateAuditReviewRow(key, {
      collectrSyncing: false,
      collectrSyncSkipped: false,
      collectrError: "",
      collectrSyncStatus: message || "Collectr sync stopped"
    }, { render: false });
  }
  recomputeAuditSummaryTotals();
  saveAuditState();
}

function compactAuditCollectrJobRow(row) {
  const item = row.item || {};
  return {
    cardId: row.cardId,
    scannedCount: Number(row.scannedCount || 0),
    sheetQuantity: Number(row.sheetQuantity || 0),
    status: row.status || "",
    unscanned: Boolean(row.unscanned),
    recordKeys: Array.isArray(row.recordKeys) ? row.recordKeys.slice(0, 20) : [],
    item: {
      cardId: item.cardId || row.cardId || "",
      name: item.name || "",
      setName: item.setName || "",
      cardNumber: item.cardNumber || "",
      variance: item.variance || "",
      grade: item.grade || "",
      portfolioName: item.portfolioName || "",
      collectrCollectionId: item.collectrCollectionId || "",
      collectrPortfolioId: item.collectrPortfolioId || "",
      collectrProductId: item.collectrProductId || "",
      collectrSubType: item.collectrSubType || "",
      collectrGradeId: item.collectrGradeId || "",
      collectrUserOwnedProductId: item.collectrUserOwnedProductId || ""
    }
  };
}

async function adjustCollectrQuantityFromAudit(row, targetQuantity) {
  const cardId = row && row.cardId || "";
  const quantity = Number(targetQuantity);
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error("Target quantity must be a non-negative integer.");
  }
  const response = await fetch("/api/collectr/quantity", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Pin": pin },
    body: JSON.stringify({
      cardId,
      targetQuantity: quantity,
      collectr: {
        portfolioName: row.collectrPortfolioName || "",
        productId: row.collectrProductId || "",
        subType: row.collectrSubType || "",
        gradeId: row.collectrGradeId || "",
        userOwnedProductId: row.collectrUserOwnedProductId || ""
      }
    })
  });
  const data = await response.json();
  if (response.status === 401) {
    lock();
    throw new Error("Scanner PIN expired. Unlock the app again.");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || "Unable to update Collectr quantity.");
  if (data.result && data.result.verified === false) {
    throw new Error("Collectr accepted the update, but API verification returned quantity " +
      (data.result.collectr && data.result.collectr.verifiedQuantity) + ".");
  }
  return data;
}

async function syncAuditCollectrReviewRow(cardId, targetQuantity, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 1);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const row = getAuditSummaryRow(cardId);
    if (!row) throw new Error("Audit review row was not found.");
    updateAuditReviewRow(cardId, {
      collectrSyncing: true,
      collectrSyncSkipped: false,
      collectrError: "",
      collectrSyncStatus: "Collectr syncing" + (attempt > 1 ? " (retry " + attempt + "/" + maxAttempts + ")" : "")
    });
    try {
      const data = await adjustCollectrQuantityFromAudit(row, targetQuantity);
      applyAuditCollectrSyncSuccess(cardId, targetQuantity, data);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        updateAuditReviewRow(cardId, {
          collectrSyncing: true,
          collectrError: "",
          collectrSyncStatus: "Collectr retry queued: " + error.message
        });
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
    }
  }
  applyAuditCollectrSyncError(cardId, lastError ? lastError.message : "Collectr sync failed.", {
    skipped: Boolean(options.skippedOnFail)
  });
  throw lastError || new Error("Collectr sync failed.");
}

async function syncAllAuditCollectrRows() {
  if (auditCollectrSyncAllRunning) return;
  const rows = getSyncableAuditReviewRows();
  if (!rows.length) {
    elements.cameraMessage.textContent = "No Collectr updates are ready to sync.";
    return;
  }
  if (!auditSummary || !auditSummary.session || !auditSummary.session.session_id) {
    setErrorStatus("Collectr sync error", "Audit session is required before syncing Collectr.");
    return;
  }

  setStatus("Collectr sync starting", "success");
  elements.cameraMessage.textContent = "Starting " + rows.length + " Collectr update" + (rows.length === 1 ? "" : "s") + " one row at a time.";
  auditCollectrSyncAllRunning = true;
  auditCollectrSyncAllStopRequested = false;
  auditCollectrSyncAllTotal = rows.length;
  auditCollectrSyncAllCompleted = 0;
  auditCollectrSyncAllFailed = 0;
  auditCollectrSyncAllRetry = 0;
  auditCollectrSyncJobId = "";
  storageRemove(localStorage, "auditCollectrSyncJobId");
  renderAuditSummary();
  try {
    for (const row of rows) {
      if (auditCollectrSyncAllStopRequested) break;
      try {
        await syncAuditCollectrReviewRow(row.cardId, Number(row.scannedCount || 0), {
          maxAttempts: 1,
          skippedOnFail: true
        });
        auditCollectrSyncAllCompleted += 1;
      } catch (_) {
        auditCollectrSyncAllFailed += 1;
      }
      renderAuditSyncProgress();
      await sleep(4000);
    }

    if (auditCollectrSyncAllStopRequested) {
      setStatus("Collectr sync stopped", "success");
      elements.cameraMessage.textContent = auditCollectrSyncAllCompleted + " synced. Sync all stopped before remaining updates.";
    } else if (auditCollectrSyncAllFailed) {
      setErrorStatus("Collectr sync finished", auditCollectrSyncAllFailed + " Collectr update" + (auditCollectrSyncAllFailed === 1 ? "" : "s") + " failed after 3 attempts.");
      elements.cameraMessage.textContent = auditCollectrSyncAllCompleted + " synced. " + auditCollectrSyncAllFailed + " failed after 3 attempts.";
    } else {
      setStatus("Collectr sync complete", "success");
      elements.cameraMessage.textContent = auditCollectrSyncAllCompleted + " Collectr update" + (auditCollectrSyncAllCompleted === 1 ? "" : "s") + " synced.";
    }
  } catch (error) {
    const message = error && error.message ? error.message : "Collectr sync failed.";
    setErrorStatus("Collectr sync error", message);
    elements.cameraMessage.textContent = message;
    for (const row of rows) {
      const current = getAuditSummaryRow(row.cardId);
      if (current && current.collectrSyncing) {
        applyAuditCollectrSyncError(row.cardId, message, { render: false });
      }
    }
    recomputeAuditSummaryTotals();
    saveAuditState();
    renderAuditSummary();
  } finally {
    auditCollectrSyncAllRunning = false;
    auditCollectrSyncAllStopRequested = false;
    auditCollectrSyncJobId = "";
    storageRemove(localStorage, "auditCollectrSyncJobId");
    auditCollectrSyncAllTotal = 0;
    auditCollectrSyncAllCompleted = 0;
    auditCollectrSyncAllFailed = 0;
    auditCollectrSyncAllRetry = 0;
    renderAuditSummary();
  }
}

function buildAuditScanEntry(cardId, sessionId) {
  return {
    recordKey: crypto.randomUUID(),
    sessionId,
    cardId,
    name: cardId,
    setName: "",
    attempts: 0,
    status: "checking",
    kind: "",
    message: "Checking inventory",
    notes: ""
  };
}

function queueAuditScan(cardId) {
  if (!auditSession) {
    throw new Error("Start an audit session first.");
  }
  const entry = buildAuditScanEntry(cardId, auditSession.session_id);
  auditScanCount += 1;
  addAuditLogEntry(entry);
  void prepareAuditScanEntry(entry.recordKey, cardId);
  setStatus("Checking audit ID", "success");
  elements.cameraMessage.textContent = cardId + " detected. Checking inventory before saving.";
}

async function prepareAuditScanEntry(recordKey, cardId) {
  if (auditLookupRecordKeys.has(recordKey)) return;
  auditLookupRecordKeys.add(recordKey);
  try {
    const response = await authenticatedFetch("/api/lookup?cardId=" + encodeURIComponent(cardId), { timeoutMs: 12000 });
    const data = await response.json();
    if (response.status === 401) {
      lock();
      throw new Error("Scanner PIN expired. Unlock the app again.");
    }
    if (!response.ok || !data.ok) throw new Error(data.error || "Lookup failed.");
    if (!data.item) {
      const reusedNotes = findMissingAuditNotesForCard(cardId, recordKey);
      if (reusedNotes) {
        updateAuditLogEntry(recordKey, {
          name: cardId,
          setName: "",
          kind: "issue",
          notes: reusedNotes,
          status: "pending",
          message: "Missing ID noted; queued for review"
        });
        void drainAuditSaveQueue();
        return;
      }
      updateAuditLogEntry(recordKey, {
        name: cardId,
        setName: "",
        kind: "issue",
        status: "needs_notes",
        message: "Missing ID; add notes or queue for review"
      });
      openMissingNotesModal(recordKey);
      return;
    }
    updateAuditLogEntry(recordKey, {
      name: data.item.name || cardId,
      setName: data.item.setName || "",
      status: "pending",
      kind: "",
      message: "Queued"
    });
    void drainAuditSaveQueue();
  } catch (error) {
    updateAuditLogEntry(recordKey, {
      status: "pending",
      message: "Queued; lookup details failed: " + error.message
    });
    void drainAuditSaveQueue();
  } finally {
    auditLookupRecordKeys.delete(recordKey);
  }
}

function recoverCheckingAuditScans() {
  const checkingEntries = auditLog.filter((entry) => {
    return entry && entry.status === "checking" && entry.recordKey && entry.cardId;
  });
  checkingEntries.forEach((entry) => {
    void prepareAuditScanEntry(entry.recordKey, entry.cardId);
  });
  return checkingEntries.length;
}

function findMissingAuditNotesForCard(cardId, excludeRecordKey = "") {
  const normalizedCardId = extractCardId(cardId).toUpperCase();
  if (!normalizedCardId) return "";
  const match = auditLog.find((entry) => {
    return entry &&
      entry.recordKey !== excludeRecordKey &&
      extractCardId(entry.cardId).toUpperCase() === normalizedCardId &&
      String(entry.notes || "").trim();
  });
  return match ? String(match.notes || "").trim() : "";
}

function openMissingNotesModal(recordKey) {
  const entry = auditLog.find((candidate) => candidate.recordKey === recordKey);
  if (!entry || entry.kind !== "issue" || (entry.status !== "needs_notes" && entry.status !== "pending")) return;
  const reusedNotes = entry.notes || findMissingAuditNotesForCard(entry.cardId, recordKey);
  if (reusedNotes && reusedNotes !== entry.notes) {
    updateAuditLogEntry(recordKey, { notes: reusedNotes });
  }
  missingNotesRecordKey = recordKey;
  elements.missingNotesCardId.textContent = entry.cardId || "Unknown card ID";
  elements.missingNotesInput.value = reusedNotes || "";
  elements.missingNotesBackdrop.hidden = false;
  elements.missingNotesModal.hidden = false;
  window.setTimeout(() => elements.missingNotesInput.focus(), 0);
}

function closeMissingNotesModal() {
  missingNotesRecordKey = "";
  elements.missingNotesBackdrop.hidden = true;
  elements.missingNotesModal.hidden = true;
}

function queueMissingAuditScan(recordKey, notes) {
  const entry = auditLog.find((candidate) => candidate.recordKey === recordKey);
  if (!entry || entry.kind !== "issue" || (entry.status !== "needs_notes" && entry.status !== "pending")) return;
  const normalizedNotes = String(notes || "").trim() || findMissingAuditNotesForCard(entry.cardId, recordKey);
  updateAuditLogEntry(recordKey, {
    notes: normalizedNotes,
    status: "pending",
    message: normalizedNotes ? "Missing ID noted; queued for review" : "Missing ID queued for review"
  });
  if (missingNotesRecordKey === recordKey) {
    closeMissingNotesModal();
  }
  void drainAuditSaveQueue();
}

async function sendAuditScan(entry) {
  const sessionId = entry.sessionId || auditSession && auditSession.session_id;
  if (!sessionId) throw new Error("Audit session is required.");
  const response = await fetch("/api/audit/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Pin": pin },
    body: JSON.stringify({
      sessionId,
      cardId: entry.cardId,
      recordKey: entry.recordKey,
      notes: entry.notes || ""
    })
  });
  const data = await response.json();
  if (response.status === 401) {
    lock();
    throw new Error("Scanner PIN expired. Unlock the app again.");
  }
  if (!response.ok || !data.ok) {
    const message = data.error || "Unable to record audit scan.";
    if (/session/i.test(message) && /not found|does not match|required/i.test(message)) {
      auditSession = null;
      saveAuditState();
      renderAuditState();
    }
    throw new Error(message);
  }
  return data;
}

async function drainAuditSaveQueue() {
  if (auditSaveRunning) return;
  auditSaveRunning = true;
  try {
    while (auditSession || auditLog.some((candidate) => candidate.status === "pending" && candidate.sessionId)) {
      const entry = auditLog.slice().reverse().find((candidate) => candidate.status === "pending");
      if (!entry) break;
      const attempts = Number(entry.attempts || 0) + 1;
      updateAuditLogEntry(entry.recordKey, { status: "syncing", attempts, message: "Writing to audit sheet" + (attempts > 1 ? " (retry " + attempts + "/3)" : "") });
      try {
        await sendAuditScan(entry);
        updateAuditLogEntry(entry.recordKey, { status: "synced", message: "Synced" });
      } catch (error) {
        if (attempts < 3 && entry.sessionId) {
          updateAuditLogEntry(entry.recordKey, { status: "pending", kind: "", attempts, message: "Retry queued: " + error.message });
          await new Promise((resolve) => setTimeout(resolve, 400 * attempts));
          continue;
        }
        updateAuditLogEntry(entry.recordKey, { status: "error", kind: "error", attempts, message: error.message });
        setErrorStatus("Audit sync error", error.message);
        elements.cameraMessage.textContent = "Sync failed after 3 attempts. Tap the pill for details or Retry on the row.";
      }
    }
  } finally {
    auditSaveRunning = false;
    renderAuditState();
  }
}

function cancelAuditScan(recordKey) {
  const entry = auditLog.find((candidate) => candidate.recordKey === recordKey);
  if (!entry || entry.status !== "pending") return;
  auditLog = auditLog.filter((candidate) => candidate.recordKey !== recordKey);
  auditScanCount = Math.max(0, auditScanCount - 1);
  saveAuditState();
  renderAuditState();
  setStatus("Scan canceled", "success");
}

async function undoAuditScan(recordKey) {
  const entry = auditLog.find((candidate) => candidate.recordKey === recordKey);
  const sessionId = entry && entry.sessionId ? entry.sessionId : auditSession && auditSession.session_id;
  if (!entry || entry.status !== "synced" || !sessionId) return;
  updateAuditLogEntry(recordKey, { status: "undoing", message: "Undoing" });
  try {
    const response = await fetch("/api/audit/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Pin": pin },
      body: JSON.stringify({
        sessionId,
        recordKey
      })
    });
    const data = await response.json();
    if (response.status === 401) {
      lock();
      throw new Error("Scanner PIN expired. Unlock the app again.");
    }
    if (!response.ok || !data.ok) throw new Error(data.error || "Unable to undo audit scan.");
    auditLog = auditLog.filter((candidate) => candidate.recordKey !== recordKey);
    auditScanCount = Math.max(0, auditScanCount - 1);
    saveAuditState();
    renderAuditState();
    setStatus(data.result && data.result.undone ? "Scan undone" : "Already undone", "success");
  } catch (error) {
    updateAuditLogEntry(recordKey, { status: "undo_error", kind: "error", message: error.message });
    setStatus("Undo error", "error");
    elements.cameraMessage.textContent = error.message;
  }
}

function addToCart(cardId, item) {
  const existing = cart.find((entry) => entry.cardId === cardId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      cardId,
      name: item.name,
      setName: item.setName,
      cardNumber: item.cardNumber,
      variance: item.variance,
      marketPrice: item.marketPrice,
      quantity: 1
    });
  }
  saveCart();
  renderCart();
}

function setMode(nextMode) {
  mode = ["lookup", "cart", "audit"].includes(nextMode) ? nextMode : "lookup";
  storageSet(localStorage, "scannerMode", mode);
  const cartMode = mode === "cart";
  const auditMode = mode === "audit";
  scanPaused = false;
  elements.lookupModeButton.classList.toggle("active", mode === "lookup");
  elements.cartModeButton.classList.toggle("active", cartMode);
  elements.auditModeButton.classList.toggle("active", auditMode);
  elements.scannerScreen.classList.toggle("lookup-mode", mode === "lookup");
  elements.modeMenuButton.setAttribute("aria-label", "Open mode menu. Current mode: " + mode);
  closeModeDrawer();
  document.querySelector("#result").hidden = cartMode || auditMode;
  elements.cartPanel.hidden = !cartMode;
  elements.auditPanel.hidden = !auditMode;
  elements.auditControls.hidden = !auditMode;
  elements.captureAuditQrButton.hidden = !auditMode;
  document.querySelector("#saveStickerPriceButton").textContent = "Save & Scan Next";
  elements.cameraMessage.textContent = scanning
    ? (cartMode ? "Scan labels consecutively to add them to the cart." : auditMode ? "Hold a label in frame, then tap Capture QR." : "Scan a label, then enter its Stickered Price.")
    : (cartMode ? "Start the camera to add labels to the cart." : auditMode ? "Start the camera to audit IDs." : "Start the camera for lookup and pricing.");
}

function openModeDrawer() {
  elements.modeDrawer.classList.add("open");
  elements.modeDrawer.setAttribute("aria-hidden", "false");
  elements.modeBackdrop.hidden = false;
  elements.modeMenuButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("drawer-open");
}

function closeModeDrawer() {
  elements.modeDrawer.classList.remove("open");
  elements.modeDrawer.setAttribute("aria-hidden", "true");
  elements.modeBackdrop.hidden = true;
  elements.modeMenuButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("drawer-open");
}

function extractCardId(rawValue) {
  const raw = String(rawValue || "").trim();
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.cardId || parsed.card_id || parsed.itemId || parsed.id || raw).trim();
  } catch (_) {}
  try {
    const url = new URL(raw);
    return String(url.searchParams.get("cardId") || url.searchParams.get("card_id") || url.searchParams.get("itemId") || url.searchParams.get("id") || raw).trim();
  } catch (_) {}
  return raw;
}

async function lookup(rawValue) {
  const cardId = extractCardId(rawValue);
  if (!cardId) return;
  elements.decodedValue.textContent = String(rawValue).trim();
  elements.decodedPanel.hidden = false;
  setStatus("Looking up…");
  if (mode === "audit" && !auditSession) {
    setStatus("Audit not started", "error");
    elements.cameraMessage.textContent = "Start an audit session before scanning.";
    return;
  }
  if (mode === "audit") {
    try {
      queueAuditScan(cardId);
    } catch (error) {
      setStatus("Audit error", "error");
      elements.cameraMessage.textContent = error.message;
    }
    return;
  }
  try {
    const response = await authenticatedFetch("/api/lookup?cardId=" + encodeURIComponent(cardId));
    const data = await response.json();
    if (response.status === 401) {
      lock();
      throw new Error("Scanner PIN expired. Unlock the app again.");
    }
    if (!response.ok || !data.ok) throw new Error(data.error || "Lookup failed.");
    if (!data.item) {
      setStatus("Not found", "error");
      elements.cameraMessage.textContent = "No spreadsheet row matched " + cardId + ".";
      return;
    }
    if (mode === "cart") {
      addToCart(cardId, data.item);
      setStatus("Added to cart", "success");
      elements.cameraMessage.textContent = (data.item.name || cardId) + " added. Ready for the next label.";
    } else {
      renderItem(cardId, data.item);
      void loadStickerTargets(cardId, data.item);
      scanPaused = true;
      lookupQueue = [];
      setStatus("Enter sticker price", "success");
      elements.cameraMessage.textContent = (data.item.name || cardId) + " found. Enter or select the price below.";
      const priceInput = document.querySelector("#stickeredPriceInput");
      setTimeout(() => { priceInput.focus(); priceInput.select(); }, 0);
    }
  } catch (error) {
    if (mode === "audit") {
      setErrorStatus("Audit error", error.message);
    } else {
      setErrorStatus("Lookup error", error.message);
    }
    elements.cameraMessage.textContent = error.message;
  }
}

function queueLookup(rawValue) {
  lookupQueue.push(rawValue);
  void drainLookupQueue();
}

async function drainLookupQueue() {
  if (lookupInProgress) return;
  lookupInProgress = true;
  try {
    while (lookupQueue.length) {
      await lookup(lookupQueue.shift());
    }
  } finally {
    lookupInProgress = false;
  }
}

async function scanFrame() {
  if (!scanning) return;
  if (scanPaused) {
    setTimeout(scanFrame, 180);
    return;
  }
  try {
    if (elements.video.videoWidth && elements.video.videoHeight) {
      const sourceSize = Math.round(Math.min(
        elements.video.videoWidth * 0.275,
        elements.video.videoHeight / 3
      ));
      const sourceX = Math.round((elements.video.videoWidth - sourceSize) / 2);
      const sourceY = Math.round((elements.video.videoHeight - sourceSize) / 2);
      const width = Math.min(700, sourceSize);
      const height = width;
      if (elements.scanCanvas.width !== width || elements.scanCanvas.height !== height) {
        elements.scanCanvas.width = width;
        elements.scanCanvas.height = height;
      }
      scanContext.drawImage(elements.video, sourceX, sourceY, sourceSize, sourceSize, 0, 0, width, height);
      const imageData = scanContext.getImageData(0, 0, width, height);
      const results = await readBarcodes(imageData, {
        formats: ["QRCode"],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        maxNumberOfSymbols: 1,
        textMode: "Plain"
      });
      const result = results.find((candidate) => candidate.isValid && candidate.text);
      if (result) {
        missedScanFrames = 0;
        if (result.text !== lastCode) {
          lastCode = result.text;
          signalQrDetection();
          if (mode === "audit") {
            setPendingAuditQr(result.text);
          } else {
            queueLookup(result.text);
          }
        }
      } else {
        missedScanFrames += 1;
        if (missedScanFrames >= 2) {
          lastCode = "";
          if (mode === "audit") {
            pendingAuditRawValue = "";
            pendingAuditCardId = "";
            elements.captureAuditQrButton.disabled = true;
            elements.captureAuditQrButton.textContent = "Capture QR";
          }
        }
      }
    }
  } catch (error) {
    setErrorStatus("Scanner error", error.message);
    elements.cameraMessage.textContent = error.message;
  }
  if (scanning) setTimeout(scanFrame, 180);
}

async function startCamera() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !audioContext) audioContext = new AudioContextClass();
    if (audioContext && audioContext.state === "suspended") await audioContext.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    elements.video.srcObject = stream;
    await elements.video.play();
    scanning = true;
    scanPaused = false;
    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    setStatus("Scanning", "success");
    elements.cameraMessage.textContent = "Center one QR label inside the blue frame.";
    if (mode === "cart") elements.cameraMessage.textContent = "Scan labels consecutively to add them to the cart.";
    if (mode === "audit") elements.cameraMessage.textContent = "Hold a label in frame, then tap Capture QR.";
    if (mode === "lookup") elements.cameraMessage.textContent = "Scan a label, then enter its Stickered Price.";
    scanFrame();
  } catch (error) {
    setErrorStatus("Camera error", error.message);
    elements.cameraMessage.textContent = error.message;
  }
}

function stopCamera() {
  scanning = false;
  scanPaused = false;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  elements.video.srcObject = null;
  elements.startButton.disabled = false;
  elements.stopButton.disabled = true;
  if (pin) setStatus("Camera stopped");
}

elements.pinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.pinMessage.textContent = "Checking…";
  try {
    await unlock(elements.pinInput.value);
  } catch (error) {
    elements.pinMessage.textContent = error.message;
  }
});
elements.startButton.addEventListener("click", startCamera);
elements.stopButton.addEventListener("click", stopCamera);
elements.lockButton.addEventListener("click", lock);
elements.status.addEventListener("click", () => {
  if (lastStatusError) window.alert(lastStatusError);
});
elements.modeMenuButton.addEventListener("click", openModeDrawer);
elements.closeModeButton.addEventListener("click", closeModeDrawer);
elements.modeBackdrop.addEventListener("click", closeModeDrawer);
elements.lookupModeButton.addEventListener("click", () => setMode("lookup"));
elements.cartModeButton.addEventListener("click", () => setMode("cart"));
elements.auditModeButton.addEventListener("click", () => setMode("audit"));
elements.captureAuditQrButton.addEventListener("click", () => {
  if (!pendingAuditCardId) {
    setErrorStatus("No QR ready", "No QR code is currently detected. Hold the label in frame, then tap Capture QR.");
    return;
  }
  try {
    queueAuditScan(pendingAuditCardId);
    pendingAuditRawValue = "";
    pendingAuditCardId = "";
    lastCode = "";
    showAuditCaptureFeedback();
  } catch (error) {
    setErrorStatus("Audit error", error.message);
    elements.cameraMessage.textContent = error.message;
  }
});
elements.auditSessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.auditSessionText.textContent = "Starting audit...";
  try {
    const sessionName = elements.auditSessionNameInput.value.trim() || ("Inventory audit " + new Date().toLocaleDateString("en-CA"));
    await startAuditSession(sessionName);
    setStatus("Audit active", "success");
    elements.cameraMessage.textContent = "Scan labels for this audit session.";
  } catch (error) {
    setErrorStatus("Audit error", error.message);
    elements.auditSessionText.textContent = error.message;
  }
});
elements.stopAuditButton.addEventListener("click", async () => {
  elements.auditSessionText.textContent = "Stopping audit...";
  try {
    const sessionId = auditSession && auditSession.session_id;
    await stopAuditSession();
    if (sessionId) {
      elements.auditSessionText.textContent = "Loading audit review...";
      await loadAuditSummary(sessionId);
    }
    setStatus("Audit review ready", "success");
    elements.cameraMessage.textContent = "Audit session stopped. Review issues below.";
  } catch (error) {
    setErrorStatus("Audit error", error.message);
    elements.auditSessionText.textContent = error.message;
  }
});
elements.auditSummaryButton.addEventListener("click", async () => {
  elements.auditSessionText.textContent = "Loading audit review...";
  try {
    await loadAuditSummary();
    setStatus("Audit review ready", "success");
    elements.cameraMessage.textContent = "Audit review loaded.";
  } catch (error) {
    setErrorStatus("Audit error", error.message);
    elements.auditSessionText.textContent = error.message;
  }
});
elements.globalAuditButton.addEventListener("click", async () => {
  elements.auditSessionText.textContent = "Loading global audit sessions...";
  try {
    await loadGlobalAuditSessions();
    setStatus("Select sessions", "success");
    elements.cameraMessage.textContent = "Select every binder or box to include in the global review.";
  } catch (error) {
    setErrorStatus("Audit error", error.message);
    elements.auditSessionText.textContent = error.message;
  }
});
elements.clearAuditLogButton.addEventListener("click", () => {
  auditLog = auditLog.filter((entry) => entry.status === "pending" || entry.status === "syncing" || entry.status === "undoing");
  saveAuditState();
  renderAuditState();
});
elements.auditLog.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-audit-action]");
  if (!button) return;
  const recordKey = button.dataset.recordKey;
  if (button.dataset.auditAction === "cancel") {
    cancelAuditScan(recordKey);
  } else if (button.dataset.auditAction === "undo") {
    void undoAuditScan(recordKey);
  } else if (button.dataset.auditAction === "retry") {
    updateAuditLogEntry(recordKey, { status: "pending", kind: "", attempts: 0, message: "Queued" });
    void drainAuditSaveQueue();
  } else if (button.dataset.auditAction === "notes") {
    openMissingNotesModal(recordKey);
  } else if (button.dataset.auditAction === "queue-missing") {
    queueMissingAuditScan(recordKey, "");
  }
});
elements.auditLog.addEventListener("submit", (event) => {
  const form = event.target.closest(".audit-entry-notes");
  if (!form) return;
  event.preventDefault();
  const notesInput = form.querySelector("input[name='notes']");
  queueMissingAuditScan(form.dataset.recordKey, notesInput ? notesInput.value : "");
});
elements.missingNotesForm.addEventListener("submit", (event) => {
  event.preventDefault();
  queueMissingAuditScan(missingNotesRecordKey, elements.missingNotesInput.value);
});
elements.missingNotesSkipButton.addEventListener("click", () => {
  queueMissingAuditScan(missingNotesRecordKey, "");
});
elements.missingNotesBackdrop.addEventListener("click", closeMissingNotesModal);
elements.globalAuditBackdrop.addEventListener("click", closeGlobalAuditModal);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.missingNotesModal.hidden) {
    closeMissingNotesModal();
  } else if (event.key === "Escape" && !elements.globalAuditModal.hidden) {
    closeGlobalAuditModal();
  }
});
elements.globalAuditModal.addEventListener("submit", async (event) => {
  const form = event.target.closest("#globalAuditSessionForm");
  if (!form) return;
  event.preventDefault();
  const sessionIds = [...form.querySelectorAll("input[name='sessionId']:checked")].map((input) => input.value);
  elements.auditSessionText.textContent = "Loading global audit review...";
  closeGlobalAuditModal();
  try {
    await loadGlobalAuditSummary(sessionIds);
    setStatus("Global review ready", "success");
    elements.cameraMessage.textContent = "Global audit review loaded. Use Sync all only after every location is included.";
  } catch (error) {
    setErrorStatus("Audit error", error.message);
    elements.auditSessionText.textContent = error.message;
  }
});
elements.globalAuditModal.addEventListener("click", (event) => {
  const closeButton = event.target.closest("button[data-global-audit-action='close']");
  if (closeButton) closeGlobalAuditModal();
});
elements.auditSummaryPanel.addEventListener("click", async (event) => {
  const syncAllButton = event.target.closest("button[data-audit-action='sync-all-collectr']");
  if (syncAllButton) {
    event.preventDefault();
    event.stopPropagation();
    syncAllButton.disabled = true;
    syncAllButton.textContent = "Starting";
    await syncAllAuditCollectrRows();
    return;
  }
  const stopSyncAllButton = event.target.closest("button[data-audit-action='stop-sync-all-collectr']");
  if (stopSyncAllButton) {
    auditCollectrSyncAllStopRequested = true;
    stopSyncAllButton.disabled = true;
    stopSyncAllButton.textContent = "Stopping";
    renderAuditSyncProgress();
    elements.cameraMessage.textContent = "Sync all will stop after the current row finishes.";
    return;
  }
  const button = event.target.closest("button[data-audit-action='adjust-collectr']");
  if (!button) return;
  const cardId = button.dataset.cardId;
  const targetQuantity = Number(button.dataset.targetQuantity);
  if (!window.confirm("Set Collectr quantity for " + cardId + " to " + targetQuantity + "?")) {
    return;
  }
  button.disabled = true;
  button.textContent = "Saving";
  try {
    await syncAuditCollectrReviewRow(cardId, targetQuantity, { maxAttempts: 1 });
    setStatus("Collectr updated", "success");
    elements.cameraMessage.textContent = "Collectr quantity updated for " + cardId + ".";
  } catch (error) {
    setErrorStatus("Collectr error", error.message);
    elements.cameraMessage.textContent = error.message;
    button.disabled = false;
    button.textContent = "Set Collectr";
  }
});
function fillStickerPriceFrom(field) {
  if (!currentLookupItem) return;
  const value = selectablePrice(currentLookupItem[field]);
  if (value === null) return;
  const input = document.querySelector("#stickeredPriceInput");
  input.value = String(value);
  setStatus(field === "marketPrice" ? "Market price selected" : "Suggested price selected", "success");
}
document.querySelector("#marketPriceOption").addEventListener("click", () => fillStickerPriceFrom("marketPrice"));
document.querySelector("#suggestedPriceOption").addEventListener("click", () => fillStickerPriceFrom("suggestedPrice"));
elements.clearCartButton.addEventListener("click", () => {
  cart = [];
  saveCart();
  renderCart();
});

function updateStickerSyncStatus() {
  const pending = stickerSaveQueue.length + (stickerSyncRunning ? 1 : 0);
  const text = document.querySelector("#stickerSyncText");
  text.textContent = stickerSyncError || (pending ? pending + " price update" + (pending === 1 ? "" : "s") + " syncing" : stickerSyncMessage);
  text.classList.toggle("sync-error", Boolean(stickerSyncError));
}

async function sendStickerUpdate(job) {
  const response = await fetch("/api/sticker-price", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Pin": pin },
    body: JSON.stringify({
      cardId: job.cardId,
      stickeredPrice: job.submittedPrice,
      sheetName: job.item.sheetName,
      rowNumber: job.item.rowNumber
    })
  });
  const data = await response.json();
  if (response.status === 401) {
    lock();
    throw new Error("Scanner PIN expired. Unlock the app again.");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || "Unable to save Stickered Price.");
  return data;
}

function isStickerLockTimeout(error) {
  return /lock timeout|holding the lock|could not obtain lock|too long/i.test(String(error && error.message || error || ""));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function queueStickerUpdate(job) {
  stickerSyncMessage = "";
  stickerSyncError = "";
  stickerSaveQueue.push({ ...job, attempts: 0 });
  updateStickerSyncStatus();
  void drainStickerSaveQueue();
}

async function drainStickerSaveQueue() {
  if (stickerSyncRunning) return;
  stickerSyncRunning = true;
  try {
    while (stickerSaveQueue.length) {
      const job = stickerSaveQueue.shift();
      updateStickerSyncStatus();
      try {
        const data = await sendStickerUpdate(job);
        const portfolioNames = (data.portfolios || []).map((portfolio) => portfolio.name).join(", ");
        stickerSyncError = "";
        stickerSyncMessage = data.matchedRows > 1
          ? "Synced: " + portfolioNames
          : "Sticker price synced";
      } catch (error) {
        if (isStickerLockTimeout(error) && Number(job.attempts || 0) < 5) {
          const attempts = Number(job.attempts || 0) + 1;
          stickerSaveQueue.unshift({ ...job, attempts });
          stickerSyncMessage = "Spreadsheet is busy; retrying price update " + attempts + "/5";
          updateStickerSyncStatus();
          await delay(750 * attempts);
          continue;
        }
        stickerSyncError = "Sync failed for " + (job.item.name || job.cardId) + ": " + error.message;
      }
    }
  } finally {
    stickerSyncRunning = false;
    updateStickerSyncStatus();
  }
}

function finishPricingCard(message) {
  scanPaused = false;
  currentLookupItem = null;
  document.querySelector("#resultContent").hidden = true;
  document.querySelector("#emptyState").hidden = false;
  document.querySelector("#result").classList.add("empty");
  elements.decodedPanel.hidden = false;
  elements.decodedValue.textContent = "Waiting for next scan";
  document.querySelector("#stickeredPriceInput").blur();
  setStatus(message, "success");
  elements.cameraMessage.textContent = "Remove this label and scan the next product.";
}

document.querySelector("#stickerPriceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const cardId = document.querySelector("#resultId").textContent.trim();
  const previousItem = currentLookupItem;
  if (!cardId || !previousItem) return;
  const input = document.querySelector("#stickeredPriceInput");
  const submittedPrice = input.value;
  const submittedBlank = submittedPrice === "";
  const previousBlank = previousItem.stickeredPrice === "" || previousItem.stickeredPrice == null;
  const changed = submittedBlank
    ? !previousBlank
    : previousBlank || Number(previousItem.stickeredPrice) !== Number(submittedPrice);
  const button = document.querySelector("#saveStickerPriceButton");
  button.disabled = true;
  const optimisticTimestamp = new Date().toISOString();
  const optimisticItem = {
    ...previousItem,
    stickeredPrice: submittedBlank ? "" : Number(submittedPrice),
    lastStickered: optimisticTimestamp,
    fields: {
      ...(previousItem.fields || {}),
      "Stickered Price": submittedBlank ? "" : Number(submittedPrice),
      "Last Stickered": optimisticTimestamp
    }
  };
  renderItem(cardId, optimisticItem);
  const saveJob = { cardId, submittedPrice, item: previousItem };
  if (mode === "lookup") {
    queueStickerUpdate(saveJob);
    button.disabled = false;
    finishPricingCard("Price queued · scan next");
    return;
  }

  setStatus("Price updated · syncing", "success");
  try {
    const data = await sendStickerUpdate(saveJob);
    if (document.querySelector("#resultId").textContent.trim() === cardId) {
      renderItem(cardId, data.item);
      setStatus(data.matchedRows > 1 ? "Synced: " + (data.portfolios || []).map((portfolio) => portfolio.name).join(", ") : "Sticker price synced", "success");
    }
  } catch (error) {
    if (pin && document.querySelector("#resultId").textContent.trim() === cardId) {
      renderItem(cardId, previousItem);
      setStatus("Save failed · change reverted", "error");
      elements.cameraMessage.textContent = error.message;
    }
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#cartItems").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest("[data-card-id]");
  if (!button || !row) return;
  const entry = cart.find((candidate) => candidate.cardId === row.dataset.cardId);
  if (!entry) return;
  entry.quantity += button.dataset.action === "increase" ? 1 : -1;
  if (entry.quantity <= 0) cart = cart.filter((candidate) => candidate !== entry);
  saveCart();
  renderCart();
});
document.querySelector("#manualForm").addEventListener("submit", (event) => {
  event.preventDefault();
  queueLookup(document.querySelector("#manualId").value);
});
window.addEventListener("pagehide", stopCamera);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
renderCart();
renderAuditState();
setMode(mode);
if (auditSession) void drainAuditSaveQueue();
if (pin) unlock(pin).catch(lock);
