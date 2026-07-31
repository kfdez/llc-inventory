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
  auditSessionText: document.querySelector("#auditSessionText"),
  auditScanCount: document.querySelector("#auditScanCount"),
  auditStatusText: document.querySelector("#auditStatusText"),
  auditSummaryPanel: document.querySelector("#auditSummaryPanel"),
  auditLog: document.querySelector("#auditLog"),
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
if (!Array.isArray(cart)) cart = [];
if (!Array.isArray(auditLog)) auditLog = [];
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

function clearStatusError() {
  lastStatusError = "";
}

function authenticatedFetch(url) {
  return fetch(url, { headers: { "X-App-Pin": pin } });
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
}

function auditStatusLabel(status) {
  return {
    "match": "Match",
    "short": "Short",
    "over": "Over",
    "not-in-sheet": "Not in sheet",
    "collectr-error": "Collectr issue"
  }[status] || "Issue";
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
  const visibleRows = (issueRows.length ? issueRows : rows).slice(0, 30);
  elements.auditSummaryPanel.hidden = false;
  elements.auditSummaryPanel.innerHTML = `<div class="audit-review-totals">
    <div><span>Unique</span><strong>${Number(totals.uniqueCount || 0)}</strong></div>
    <div><span>Issues</span><strong>${Number(totals.issueCount || 0)}</strong></div>
    <div><span>Sheet qty</span><strong>${Number(totals.sheetQuantity || 0)}</strong></div>
    <div><span>Collectr qty</span><strong>${Number(totals.collectrQuantity || 0)}</strong></div>
  </div>
  <div class="audit-review-list">
    ${visibleRows.length ? visibleRows.map((row) => {
      const item = row.item || {};
      const title = item.name || row.cardId || "Unknown card";
      const meta = [item.portfolioName || row.collectrPortfolioName, item.setName, item.cardNumber].filter(Boolean).join(" | ");
      const collectrText = row.collectrError ? "Collectr: " + row.collectrError : "Collectr " + (row.collectrQuantity ?? "-");
      const canAdjustCollectr = row.item && !row.collectrError && row.collectrQuantity !== null &&
        Number(row.collectrQuantity || 0) !== Number(row.scannedCount || 0);
      return `<div class="audit-review-row ${row.status === "match" ? "" : "issue"}">
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
  elements.auditSummaryButton.disabled = !auditSession && !(auditSummary && auditSummary.session);
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
      return `<div class="audit-entry ${entry.kind || ""}">
        <div class="audit-entry-copy"><strong>${escapeHtml(entry.name || "Unknown card")}</strong><small>${escapeHtml(subtitle)}</small></div>
        <span>${escapeHtml(entry.message || "Recorded")}</span>
        <div class="audit-entry-actions">
          ${canCancel ? `<button type="button" class="secondary compact-button" data-audit-action="cancel" data-record-key="${escapeHtml(entry.recordKey)}">Cancel</button>` : ""}
          ${canUndo ? `<button type="button" class="secondary compact-button" data-audit-action="undo" data-record-key="${escapeHtml(entry.recordKey)}">Undo</button>` : ""}
          ${canRetry ? `<button type="button" class="secondary compact-button" data-audit-action="retry" data-record-key="${escapeHtml(entry.recordKey)}">Retry</button>` : ""}
        </div>
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
    elements.captureAuditQrButton.textContent = "Capture QR";
    elements.decodedValue.textContent = pendingAuditRawValue;
    elements.decodedPanel.hidden = false;
    clearStatusError();
    setStatus("QR ready", "success");
    elements.cameraMessage.textContent = "QR detected. Tap Capture QR to add it to the audit queue.";
  } else {
    elements.captureAuditQrButton.textContent = "Capture QR";
  }
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
  const normalizedSessionId = String(sessionId || auditSession && auditSession.session_id || auditSummary && auditSummary.session && auditSummary.session.session_id || "").trim();
  if (!normalizedSessionId) throw new Error("Audit session is required.");
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
  auditSummary = data.summary;
  saveAuditState();
  renderAuditState();
  return auditSummary;
}

async function adjustCollectrQuantityFromAudit(cardId, targetQuantity) {
  const quantity = Number(targetQuantity);
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error("Target quantity must be a non-negative integer.");
  }
  if (!window.confirm("Set Collectr quantity for " + cardId + " to " + quantity + "?")) {
    return;
  }
  const response = await fetch("/api/collectr/quantity", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Pin": pin },
    body: JSON.stringify({ cardId, targetQuantity: quantity })
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
  await loadAuditSummary();
}

function buildAuditScanEntry(cardId, sessionId) {
  return {
    recordKey: crypto.randomUUID(),
    sessionId,
    cardId,
    name: cardId,
    setName: "",
    attempts: 0,
    status: "pending",
    kind: "",
    message: "Queued"
  };
}

function queueAuditScan(cardId) {
  if (!auditSession) {
    throw new Error("Start an audit session first.");
  }
  const entry = buildAuditScanEntry(cardId, auditSession.session_id);
  auditScanCount += 1;
  addAuditLogEntry(entry);
  void enrichAuditEntry(entry.recordKey, cardId);
  setStatus("Audit queued", "success");
  elements.cameraMessage.textContent = cardId + " queued. Keep scanning.";
  void drainAuditSaveQueue();
}

async function enrichAuditEntry(recordKey, cardId) {
  try {
    const response = await authenticatedFetch("/api/lookup?cardId=" + encodeURIComponent(cardId));
    const data = await response.json();
    if (response.status === 401) {
      lock();
      throw new Error("Scanner PIN expired. Unlock the app again.");
    }
    if (!response.ok || !data.ok) throw new Error(data.error || "Lookup failed.");
    if (!data.item) {
      updateAuditLogEntry(recordKey, {
        name: cardId,
        setName: "",
        kind: "issue",
        message: "ID not found in inventory; queued for review"
      });
      return;
    }
    updateAuditLogEntry(recordKey, {
      name: data.item.name || cardId,
      setName: data.item.setName || "",
      kind: "",
      message: auditLog.find((entry) => entry.recordKey === recordKey)?.message || "Queued"
    });
  } catch (error) {
    updateAuditLogEntry(recordKey, {
      message: "Queued; lookup details failed: " + error.message
    });
  }
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
      recordKey: entry.recordKey
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
    elements.captureAuditQrButton.disabled = true;
    elements.captureAuditQrButton.textContent = "Capture QR";
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
  }
});
elements.auditSummaryPanel.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-audit-action='adjust-collectr']");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Saving";
  try {
    await adjustCollectrQuantityFromAudit(button.dataset.cardId, button.dataset.targetQuantity);
    setStatus("Collectr updated", "success");
    elements.cameraMessage.textContent = "Collectr quantity updated and review refreshed.";
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
