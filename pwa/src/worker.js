function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

const LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000;
const LOOKUP_NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const LOOKUP_STALE_TTL_MS = 2 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX_ENTRIES = 2500;
const INVENTORY_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const INVENTORY_SNAPSHOT_STALE_TTL_MS = 2 * 60 * 60 * 1000;
const lookupCache = new Map();
let inventorySnapshot = null;
let inventorySnapshotPromise = null;
let inventorySnapshotLastError = "";

function normalizeCardId(cardId) {
  return String(cardId || "").trim().toUpperCase();
}

function cloneLookupData(data) {
  return data ? JSON.parse(JSON.stringify(data)) : data;
}

function pruneLookupCache(now = Date.now()) {
  for (const [key, entry] of lookupCache) {
    if (entry.staleUntil <= now) lookupCache.delete(key);
  }
  while (lookupCache.size > LOOKUP_CACHE_MAX_ENTRIES) {
    lookupCache.delete(lookupCache.keys().next().value);
  }
}

function getLookupCache(cardId, options = {}) {
  const key = normalizeCardId(cardId);
  if (!key) return null;
  const entry = lookupCache.get(key);
  if (!entry) return null;

  const now = Date.now();
  if (entry.expiresAt > now || (options.allowStale && entry.staleUntil > now)) {
    entry.lastAccessed = now;
    lookupCache.delete(key);
    lookupCache.set(key, entry);
    return {
      data: cloneLookupData(entry.data),
      state: entry.expiresAt > now ? "hit" : "stale",
      ageMs: now - entry.cachedAt
    };
  }

  lookupCache.delete(key);
  return null;
}

function setLookupCache(cardId, data, ttlMs = LOOKUP_CACHE_TTL_MS) {
  const key = normalizeCardId(cardId);
  if (!key || !data) return;

  const now = Date.now();
  lookupCache.set(key, {
    data: cloneLookupData(data),
    cachedAt: now,
    lastAccessed: now,
    expiresAt: now + ttlMs,
    staleUntil: now + LOOKUP_STALE_TTL_MS
  });
  pruneLookupCache(now);
}

function clearLookupCache(cardId) {
  const key = normalizeCardId(cardId);
  if (key) lookupCache.delete(key);
}

function withLookupCacheMeta(data, state, ageMs) {
  return {
    ...data,
    lookupCache: {
      state,
      ageMs
    }
  };
}

function withSnapshotMeta(item, state, ageMs) {
  const snapshotMeta = inventorySnapshot ? {
    state,
    ageMs,
    generatedAt: inventorySnapshot.generatedAt,
    rowCount: inventorySnapshot.rowCount,
    itemCount: inventorySnapshot.itemCount
  } : { state, ageMs };
  return {
    ok: true,
    item,
    lookupCache: snapshotMeta
  };
}

function getInventorySnapshotLookup(cardId, options = {}) {
  if (!inventorySnapshot) return null;
  const now = Date.now();
  const fresh = inventorySnapshot.expiresAt > now;
  if (!fresh && inventorySnapshot.staleUntil <= now) {
    inventorySnapshot = null;
    return null;
  }
  if (!fresh && !options.allowStale) return null;
  const key = normalizeCardId(cardId);
  return {
    item: cloneLookupData(inventorySnapshot.itemsById.get(key) || null),
    state: fresh ? "snapshot" : "snapshot-stale",
    ageMs: now - inventorySnapshot.fetchedAt
  };
}

async function fetchInventorySnapshot(env) {
  const appsScriptUrl = new URL(env.APPS_SCRIPT_API_BASE_URL);
  appsScriptUrl.searchParams.set("path", "inventory/lookup-snapshot");
  const response = await fetch(appsScriptUrl, { redirect: "follow" });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error("The spreadsheet service returned an invalid inventory snapshot.");
  }
  if (!response.ok || !data.ok || !data.snapshot || !data.snapshot.itemsById) {
    throw new Error(data.error || "Inventory snapshot failed.");
  }

  const now = Date.now();
  inventorySnapshot = {
    generatedAt: data.snapshot.generatedAt,
    rowCount: data.snapshot.rowCount || 0,
    itemCount: data.snapshot.itemCount || 0,
    duplicateIds: data.snapshot.duplicateIds || [],
    fetchedAt: now,
    expiresAt: now + INVENTORY_SNAPSHOT_TTL_MS,
    staleUntil: now + INVENTORY_SNAPSHOT_STALE_TTL_MS,
    itemsById: new Map(Object.entries(data.snapshot.itemsById))
  };
  inventorySnapshotLastError = "";
  return inventorySnapshot;
}

async function ensureInventorySnapshot(env, options = {}) {
  const cached = getInventorySnapshotLookup("__snapshot_probe__", { allowStale: options.allowStale });
  if (cached && !options.force) return inventorySnapshot;
  if (!inventorySnapshotPromise) {
    inventorySnapshotPromise = fetchInventorySnapshot(env)
      .catch((error) => {
        inventorySnapshotLastError = error.message;
        throw error;
      })
      .finally(() => {
        inventorySnapshotPromise = null;
      });
  }
  return inventorySnapshotPromise;
}

function updateInventorySnapshotItem(cardId, item) {
  if (!inventorySnapshot) return;
  const key = normalizeCardId(cardId);
  if (!key) return;
  if (item) {
    inventorySnapshot.itemsById.set(key, cloneLookupData(item));
    inventorySnapshot.itemCount = inventorySnapshot.itemsById.size;
  } else {
    inventorySnapshot.itemsById.delete(key);
    inventorySnapshot.itemCount = inventorySnapshot.itemsById.size;
  }
}

function getInventorySnapshotStatus() {
  const now = Date.now();
  if (!inventorySnapshot) {
    return {
      loaded: false,
      loading: Boolean(inventorySnapshotPromise),
      state: inventorySnapshotPromise ? "warming" : "cold",
      lastError: inventorySnapshotLastError
    };
  }
  const fresh = inventorySnapshot.expiresAt > now;
  const staleAvailable = inventorySnapshot.staleUntil > now;
  return {
    loaded: true,
    loading: Boolean(inventorySnapshotPromise),
    state: fresh ? "fresh" : staleAvailable ? "stale" : "expired",
    ageMs: now - inventorySnapshot.fetchedAt,
    generatedAt: inventorySnapshot.generatedAt,
    rowCount: inventorySnapshot.rowCount,
    itemCount: inventorySnapshot.itemCount,
    duplicateIdCount: inventorySnapshot.duplicateIds.length,
    expiresInMs: Math.max(0, inventorySnapshot.expiresAt - now),
    staleExpiresInMs: Math.max(0, inventorySnapshot.staleUntil - now),
    lastError: inventorySnapshotLastError
  };
}

function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function isAuthorized(request, env) {
  if (!env.APP_PIN || !env.APPS_SCRIPT_API_BASE_URL) {
    return { ok: false, response: json({ ok: false, error: "The scanner service is not configured." }, 503) };
  }
  if (!safeEqual(request.headers.get("X-App-Pin"), env.APP_PIN)) {
    return { ok: false, response: json({ ok: false, error: "Incorrect scanner PIN." }, 401) };
  }
  return { ok: true };
}

async function appsScriptPost(env, path, payload) {
  const appsScriptUrl = new URL(env.APPS_SCRIPT_API_BASE_URL);
  const response = await fetch(appsScriptUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, payload })
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error("The spreadsheet service returned an invalid response.");
  }
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Spreadsheet request failed.");
  }
  return data;
}

async function lookup(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;

  const requestUrl = new URL(request.url);
  const cardId = String(requestUrl.searchParams.get("cardId") || "").trim();
  if (!cardId || cardId.length > 200) {
    return json({ ok: false, error: "A valid Card ID is required." }, 400);
  }

  const cached = getLookupCache(cardId);
  if (cached) {
    return json(withLookupCacheMeta(cached.data, cached.state, cached.ageMs));
  }

  try {
    await ensureInventorySnapshot(env);
    const snapshotLookup = getInventorySnapshotLookup(cardId);
    if (snapshotLookup) {
      return json(withSnapshotMeta(snapshotLookup.item, snapshotLookup.state, snapshotLookup.ageMs));
    }
  } catch (_) {
    const staleSnapshotLookup = getInventorySnapshotLookup(cardId, { allowStale: true });
    if (staleSnapshotLookup) {
      return json(withSnapshotMeta(staleSnapshotLookup.item, staleSnapshotLookup.state, staleSnapshotLookup.ageMs));
    }
  }

  const appsScriptUrl = new URL(env.APPS_SCRIPT_API_BASE_URL);
  appsScriptUrl.searchParams.set("path", "inventory/lookup");
  appsScriptUrl.searchParams.set("cardId", cardId);

  try {
    const response = await fetch(appsScriptUrl, { redirect: "follow" });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return json({ ok: false, error: "The spreadsheet service returned an invalid response." }, 502);
    }
    if (!response.ok || !data.ok) {
      return json({ ok: false, error: data.error || "Spreadsheet lookup failed." }, 502);
    }
    setLookupCache(cardId, data, data.item ? LOOKUP_CACHE_TTL_MS : LOOKUP_NEGATIVE_CACHE_TTL_MS);
    return json(data);
  } catch (error) {
    const stale = getLookupCache(cardId, { allowStale: true });
    if (stale) {
      return json(withLookupCacheMeta(stale.data, stale.state, stale.ageMs));
    }
    return json({ ok: false, error: "Spreadsheet lookup failed: " + error.message }, 502);
  }
}

async function updateStickerPrice(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }
  const cardId = String(payload.cardId || "").trim();
  if (!cardId || cardId.length > 200) {
    return json({ ok: false, error: "A valid Card ID is required." }, 400);
  }

  try {
    const data = await appsScriptPost(env, "inventory/sticker-price", {
      cardId,
      stickeredPrice: payload.stickeredPrice,
      sheetName: payload.sheetName,
      rowNumber: payload.rowNumber
    });
    const responseBody = {
      ok: true,
      changed: data.result.changed,
      matchedRows: data.result.matchedRows,
      changedRows: data.result.changedRows,
      portfolios: data.result.portfolios,
      item: data.result.item
    };
    if (responseBody.item) {
      setLookupCache(cardId, {
        ok: true,
        item: responseBody.item
      });
      updateInventorySnapshotItem(cardId, responseBody.item);
    } else {
      clearLookupCache(cardId);
      updateInventorySnapshotItem(cardId, null);
    }
    return json(responseBody);
  } catch (error) {
    return json({ ok: false, error: "Stickered Price update failed: " + error.message }, 502);
  }
}

async function getStickerTargets(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  const requestUrl = new URL(request.url);
  const cardId = String(requestUrl.searchParams.get("cardId") || "").trim();
  if (!cardId || cardId.length > 200) return json({ ok: false, error: "A valid Card ID is required." }, 400);
  const appsScriptUrl = new URL(env.APPS_SCRIPT_API_BASE_URL);
  appsScriptUrl.searchParams.set("path", "inventory/sticker-targets");
  appsScriptUrl.searchParams.set("cardId", cardId);
  appsScriptUrl.searchParams.set("sheetName", requestUrl.searchParams.get("sheetName") || "");
  appsScriptUrl.searchParams.set("rowNumber", requestUrl.searchParams.get("rowNumber") || "");
  try {
    const response = await fetch(appsScriptUrl, { redirect: "follow" });
    const data = await response.json();
    if (!response.ok || !data.ok) return json({ ok: false, error: data.error || "Unable to load matching portfolios." }, 502);
    return json({ ok: true, ...data.result });
  } catch (error) {
    return json({ ok: false, error: "Unable to load matching portfolios: " + error.message }, 502);
  }
}

async function startAudit(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }
  const sessionName = String(payload.sessionName || "").trim();
  if (!sessionName || sessionName.length > 80) {
    return json({ ok: false, error: "Audit session name is required." }, 400);
  }
  try {
    const data = await appsScriptPost(env, "audit/start", {
      threadId: "pwa-audit",
      sessionName,
      startedBy: "PWA Scanner"
    });
    return json({ ok: true, session: data.session });
  } catch (error) {
    return json({ ok: false, error: "Audit start failed: " + error.message }, 502);
  }
}

async function stopAudit(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  try {
    const data = await appsScriptPost(env, "audit/stop", {
      threadId: "pwa-audit",
      endedBy: "PWA Scanner"
    });
    return json({ ok: true, session: data.session || null });
  } catch (error) {
    return json({ ok: false, error: "Audit stop failed: " + error.message }, 502);
  }
}

async function recordAuditScan(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }
  const sessionId = String(payload.sessionId || "").trim();
  const cardId = String(payload.cardId || "").trim();
  if (!sessionId) return json({ ok: false, error: "Audit session is required." }, 400);
  if (!cardId || cardId.length > 200) return json({ ok: false, error: "A valid Card ID is required." }, 400);
  try {
    const data = await appsScriptPost(env, "audit/scan", {
      threadId: "pwa-audit",
      sessionId,
      messageId: "pwa-" + crypto.randomUUID(),
      sourceTimestampMs: Date.now(),
      senderId: "pwa",
      senderName: "PWA Scanner",
      scans: [{
        cardId,
        qrIndex: 0,
        recordKey: String(payload.recordKey || crypto.randomUUID()).trim(),
        payloadHash: cardId
      }]
    });
    return json({ ok: true, result: data.result });
  } catch (error) {
    return json({ ok: false, error: "Audit scan failed: " + error.message }, 502);
  }
}

async function undoAuditScan(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }
  const sessionId = String(payload.sessionId || "").trim();
  const recordKey = String(payload.recordKey || "").trim();
  if (!sessionId) return json({ ok: false, error: "Audit session is required." }, 400);
  if (!recordKey) return json({ ok: false, error: "Scan record key is required." }, 400);
  try {
    const data = await appsScriptPost(env, "audit/undo", {
      threadId: "pwa-audit",
      sessionId,
      recordKey
    });
    return json({ ok: true, result: data.result });
  } catch (error) {
    return json({ ok: false, error: "Audit undo failed: " + error.message }, 502);
  }
}

async function cacheStatus(request, env, ctx) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  const requestUrl = new URL(request.url);
  const warm = requestUrl.searchParams.get("warm") === "1";
  const refresh = requestUrl.searchParams.get("refresh") === "1";

  if (refresh) {
    try {
      await ensureInventorySnapshot(env, { force: true });
    } catch (error) {
      return json({ ok: false, error: "Inventory cache refresh failed: " + error.message, cache: getInventorySnapshotStatus() }, 502);
    }
  } else if (warm) {
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(ensureInventorySnapshot(env).catch(() => {}));
    } else {
      void ensureInventorySnapshot(env).catch(() => {});
    }
  }

  return json({ ok: true, cache: getInventorySnapshotStatus() });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session") {
      if (!env.APP_PIN) return json({ ok: false, error: "The scanner service is not configured." }, 503);
      if (!safeEqual(request.headers.get("X-App-Pin"), env.APP_PIN)) return json({ ok: false, error: "Incorrect scanner PIN." }, 401);
      if (ctx && ctx.waitUntil) ctx.waitUntil(ensureInventorySnapshot(env).catch(() => {}));
      return json({ ok: true });
    }
    if (url.pathname === "/api/lookup") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);
      return lookup(request, env);
    }
    if (url.pathname === "/api/cache-status") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);
      return cacheStatus(request, env, ctx);
    }
    if (url.pathname === "/api/sticker-price") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return updateStickerPrice(request, env);
    }
    if (url.pathname === "/api/sticker-targets") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);
      return getStickerTargets(request, env);
    }
    if (url.pathname === "/api/audit/start") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return startAudit(request, env);
    }
    if (url.pathname === "/api/audit/stop") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return stopAudit(request, env);
    }
    if (url.pathname === "/api/audit/scan") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return recordAuditScan(request, env);
    }
    if (url.pathname === "/api/audit/undo") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return undoAuditScan(request, env);
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};

export { safeEqual, normalizeCardId };
