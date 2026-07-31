import { isAuthorized, json, safeEqual, secureAssetHeaders } from "./worker/http.js";

const LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000;
const LOOKUP_NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const LOOKUP_STALE_TTL_MS = 2 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX_ENTRIES = 2500;
const INVENTORY_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const INVENTORY_SNAPSHOT_STALE_TTL_MS = 2 * 60 * 60 * 1000;
const COLLECTR_API_BASE_URL = "https://api-v2.getcollectr.com";
const COLLECTR_PORTFOLIO_CACHE_TTL_MS = 10 * 60 * 1000;
const lookupCache = new Map();
let inventorySnapshot = null;
let inventorySnapshotPromise = null;
let inventorySnapshotLastError = "";
let collectrPortfolioCache = null;

function normalizeCardId(cardId) {
  return String(cardId || "").trim().toUpperCase();
}

function normalizeCollectrMatchValue(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function buildCollectrMatchKey(setName, cardNumber, variance) {
  return [setName, cardNumber, variance].map(normalizeCollectrMatchValue).join("|");
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

async function appsScriptGet(env, path, query = {}) {
  const appsScriptUrl = new URL(env.APPS_SCRIPT_API_BASE_URL);
  appsScriptUrl.searchParams.set("path", path);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      appsScriptUrl.searchParams.set(key, String(value));
    }
  });
  const response = await fetch(appsScriptUrl, { redirect: "follow" });
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

function requireCollectrConfig(env) {
  const accountId = String(env.COLLECTR_ACCOUNT_ID || "").trim();
  const proxyBaseUrl = String(env.COLLECTR_PROXY_BASE_URL || "").trim();
  const proxySecret = String(env.COLLECTR_PROXY_SECRET || "").trim();
  const token = String(env.COLLECTR_AUTH_TOKEN || "").trim();
  if (!accountId || (!token && !(proxyBaseUrl && proxySecret))) {
    throw new Error("Collectr is not configured.");
  }
  return {
    accountId,
    token,
    apiBaseUrl: String(env.COLLECTR_API_BASE_URL || COLLECTR_API_BASE_URL).trim(),
    proxyBaseUrl,
    proxySecret,
    currency: String(env.COLLECTR_CURRENCY || "CAD").trim().toUpperCase()
  };
}

function buildCollectrProxyUrl(proxyBaseUrl) {
  const base = String(proxyBaseUrl || "").trim();
  const normalizedBase = base.endsWith("/") ? base : base + "/";
  return new URL("collectr/api", normalizedBase);
}

async function collectrRequestJson(env, path, query = {}, options = {}) {
  const config = requireCollectrConfig(env);
  const method = String(options.method || "GET").toUpperCase();
  if (config.proxyBaseUrl) {
    if (!config.proxySecret) {
      throw new Error("Collectr proxy secret is not configured.");
    }
    const response = await fetch(buildCollectrProxyUrl(config.proxyBaseUrl), {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Collectr-Proxy-Secret": config.proxySecret
      },
      body: JSON.stringify({ path, query, method, body: options.body || {} })
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text || "{}");
    } catch (_) {
      throw new Error(
        "Collectr proxy returned an invalid JSON response: HTTP " + response.status +
        ", content-type " + (response.headers.get("content-type") || "unknown") +
        ", body " + text.replace(/\s+/g, " ").slice(0, 180)
      );
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Collectr proxy request failed with HTTP " + response.status + ".");
    }
    return data.data;
  }

  const url = new URL(path, config.apiBaseUrl);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": config.token,
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
      "Collectr returned an invalid JSON response: HTTP " + response.status +
      ", content-type " + (response.headers.get("content-type") || "unknown") +
      ", body " + text.replace(/\s+/g, " ").slice(0, 180)
    );
  }
  if (!response.ok) {
    throw new Error(data.error || data.message || "Collectr request failed with HTTP " + response.status + ".");
  }
  return data;
}

function collectrGetJson(env, path, query = {}) {
  return collectrRequestJson(env, path, query);
}

function collectrPostJson(env, path, query = {}, body = {}) {
  return collectrRequestJson(env, path, query, { method: "POST", body });
}

async function fetchCollectrPortfolios(env) {
  const now = Date.now();
  const config = requireCollectrConfig(env);
  const cacheKey = config.apiBaseUrl + "|" + config.accountId;
  if (collectrPortfolioCache && collectrPortfolioCache.cacheKey === cacheKey && collectrPortfolioCache.expiresAt > now) {
    return cloneLookupData(collectrPortfolioCache.data);
  }

  const data = await collectrGetJson(env, "/accounts/" + encodeURIComponent(config.accountId) + "/collections");
  const portfolios = Array.isArray(data.data) ? data.data : [];
  collectrPortfolioCache = {
    cacheKey,
    data: portfolios,
    expiresAt: now + COLLECTR_PORTFOLIO_CACHE_TTL_MS
  };
  return cloneLookupData(portfolios);
}

function resolveCollectrPortfolio(item, portfolios) {
  const directId = String(item.collectrCollectionId || item.collectrPortfolioId || "").trim();
  if (directId) {
    const portfolio = portfolios.find((candidate) => String(candidate.id || "").trim() === directId);
    return {
      ok: true,
      source: "inventory",
      portfolio: portfolio || { id: directId, name: item.portfolioName || "" },
      warnings: portfolio ? [] : ["Collectr Collection ID was found in inventory but not in the live portfolio list."]
    };
  }

  const portfolioName = String(item.portfolioName || "").trim();
  if (!portfolioName) {
    return { ok: false, error: "Inventory row has no Portfolio Name or Collectr Collection ID.", portfolio: null, warnings: [] };
  }

  const matches = portfolios.filter((portfolio) =>
    normalizeCollectrMatchValue(portfolio.name) === normalizeCollectrMatchValue(portfolioName)
  );
  if (matches.length === 1) {
    return { ok: true, source: "collectr-name", portfolio: matches[0], warnings: [] };
  }
  if (!matches.length) {
    return { ok: false, error: "Collectr portfolio not found: " + portfolioName, portfolio: null, warnings: [] };
  }
  return { ok: false, error: "Collectr portfolio match is ambiguous: " + portfolioName, portfolio: null, warnings: [] };
}

function findUniqueCollectrProduct(item, products) {
  const expectedName = normalizeCollectrMatchValue(item.name);
  const expectedSet = normalizeCollectrMatchValue(item.setName);
  const expectedNumber = normalizeCollectrMatchValue(item.cardNumber);
  const expectedSubtype = normalizeCollectrMatchValue(item.collectrSubType || item.variance);

  const exactMatches = products.filter((product) =>
    normalizeCollectrMatchValue(product.catalog_group) === expectedSet &&
    normalizeCollectrMatchValue(product.card_number) === expectedNumber &&
    (!expectedName || normalizeCollectrMatchValue(product.product_name) === expectedName) &&
    (!expectedSubtype || normalizeCollectrMatchValue(product.product_sub_type) === expectedSubtype)
  );
  if (exactMatches.length === 1) return { ok: true, product: exactMatches[0], source: "catalog-exact" };
  if (exactMatches.length > 1) return { ok: false, error: "Collectr product match is ambiguous: " + exactMatches.length + " exact matches." };

  const lineMatches = products.filter((product) =>
    normalizeCollectrMatchValue(product.catalog_group) === expectedSet &&
    normalizeCollectrMatchValue(product.card_number) === expectedNumber
  );
  if (lineMatches.length === 1) return { ok: true, product: lineMatches[0], source: "catalog-line" };
  if (lineMatches.length > 1) return { ok: false, error: "Collectr product match is ambiguous: " + lineMatches.length + " line matches." };

  if (products.length === 1) return { ok: true, product: products[0], source: "catalog-single" };
  return { ok: false, error: "Collectr product not found." };
}

async function resolveCollectrProduct(env, item) {
  const directId = String(item.collectrProductId || "").trim();
  if (directId) {
    return {
      ok: true,
      source: "inventory",
      product: {
        product_id: directId,
        product_sub_type: item.collectrSubType || item.variance || "",
        grade_id: item.collectrGradeId || "",
        user_owned_product_id: item.collectrUserOwnedProductId || "",
        product_name: item.name || "",
        catalog_group: item.setName || "",
        card_number: item.cardNumber || ""
      }
    };
  }

  const config = requireCollectrConfig(env);
  const searchString = [item.setName, item.name, item.cardNumber]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\t");
  if (!searchString) {
    return { ok: false, error: "Inventory row does not have enough detail to search Collectr." };
  }

  const data = await collectrGetJson(env, "/catalog", {
    username: config.accountId,
    searchString,
    filters: "",
    offset: 0,
    limit: 30,
    unstackedView: "true"
  });
  return findUniqueCollectrProduct(item, Array.isArray(data.data) ? data.data : []);
}

async function fetchCollectrOwnedProduct(env, portfolioId, productId) {
  const config = requireCollectrConfig(env);
  const data = await collectrGetJson(env, "/collections/" + encodeURIComponent(config.accountId) + "/products", {
    collectionId: portfolioId,
    productIds: productId,
    unstackedView: "true",
    currency: config.currency
  });
  return Array.isArray(data.data) ? data.data : [];
}

function flattenCollectrProductDetailLines(data) {
  const product = data && data.data ? data.data : {};
  const groups = []
    .concat(Array.isArray(product.ungraded_sub_types) ? product.ungraded_sub_types : [])
    .concat(Array.isArray(product.graded_sub_types) ? product.graded_sub_types : [])
    .concat(Array.isArray(product.product_sub_types) ? product.product_sub_types : []);
  return groups.map((line) => ({
    ...line,
    product_id: product.product_id,
    product_name: product.product_name,
    catalog_group: product.catalog_group,
    card_number: product.card_number,
    product_sub_type: line.product_sub_type || line.subType || line.sub_type || "",
    grade_id: line.grade_id || line.gradeId || "",
    quantity: line.quantity || 0,
    user_owned_product_id: line.user_owned_product_id || line.userOwnedProductId || ""
  }));
}

async function fetchCollectrProductDetailLines(env, portfolioId, productId) {
  const config = requireCollectrConfig(env);
  const data = await collectrGetJson(env, "/collections/" + encodeURIComponent(config.accountId) + "/products/" + encodeURIComponent(productId), {
    collectionId: portfolioId,
    currency: config.currency,
    details: "false"
  });
  return flattenCollectrProductDetailLines(data);
}

async function resolveCollectrItem(env, item) {
  const portfolios = await fetchCollectrPortfolios(env);
  const portfolioResolution = resolveCollectrPortfolio(item, portfolios);
  if (!portfolioResolution.ok) {
    const error = new Error(portfolioResolution.error);
    error.status = 409;
    error.portfolios = portfolios.map((portfolio) => ({ id: portfolio.id, name: portfolio.name }));
    throw error;
  }

  const productResolution = await resolveCollectrProduct(env, item);
  if (!productResolution.ok) {
    const error = new Error(productResolution.error);
    error.status = 409;
    error.portfolio = {
      id: portfolioResolution.portfolio.id,
      name: portfolioResolution.portfolio.name || item.portfolioName || ""
    };
    throw error;
  }

  const listOwnedProducts = await fetchCollectrOwnedProduct(
    env,
    portfolioResolution.portfolio.id,
    productResolution.product.product_id
  );
  const detailOwnedProducts = await fetchCollectrProductDetailLines(
    env,
    portfolioResolution.portfolio.id,
    productResolution.product.product_id
  );
  const ownedProducts = detailOwnedProducts.length ? detailOwnedProducts : listOwnedProducts;
  const expectedSubtype = normalizeCollectrMatchValue(
    productResolution.product.product_sub_type || item.collectrSubType || item.variance
  );
  const expectedGradeId = String(productResolution.product.grade_id || item.collectrGradeId || "").trim();
  const ownedMatches = ownedProducts.filter((product) =>
    String(product.product_id || "") === String(productResolution.product.product_id || "") &&
    (!expectedSubtype || normalizeCollectrMatchValue(product.product_sub_type) === expectedSubtype) &&
    (!expectedGradeId || String(product.grade_id || "") === expectedGradeId)
  );
  const selectedOwnedProduct = ownedMatches.length === 1 ? ownedMatches[0] :
    ownedProducts.length === 1 ? ownedProducts[0] : null;

  const warnings = portfolioResolution.warnings.slice();
  if (ownedMatches.length > 1) warnings.push("Collectr owned product lookup returned multiple matching lines.");
  if (!selectedOwnedProduct) warnings.push("Product is not currently present in the resolved Collectr portfolio.");

  return {
    portfolio: {
      id: portfolioResolution.portfolio.id,
      name: portfolioResolution.portfolio.name || item.portfolioName || "",
      source: portfolioResolution.source
    },
    product: {
      id: String(productResolution.product.product_id || ""),
      name: productResolution.product.product_name || item.name || "",
      setName: productResolution.product.catalog_group || item.setName || "",
      cardNumber: productResolution.product.card_number || item.cardNumber || "",
      subType: selectedOwnedProduct && selectedOwnedProduct.product_sub_type ||
        productResolution.product.product_sub_type || item.collectrSubType || item.variance || "",
      gradeId: selectedOwnedProduct && selectedOwnedProduct.grade_id ||
        productResolution.product.grade_id || item.collectrGradeId || "",
      userOwnedProductId: selectedOwnedProduct && selectedOwnedProduct.user_owned_product_id ||
        productResolution.product.user_owned_product_id || item.collectrUserOwnedProductId || "",
      source: productResolution.source
    },
    collectr: {
      currentQuantity: selectedOwnedProduct ? Number(selectedOwnedProduct.quantity || 0) : 0,
      ownedLineCount: ownedProducts.length,
      matchedOwnedLineCount: ownedMatches.length,
      currency: String(env.COLLECTR_CURRENCY || "CAD").trim().toUpperCase()
    },
    warnings
  };
}

async function setCollectrItemQuantity(env, item, targetQuantity) {
  if (!Number.isInteger(targetQuantity) || targetQuantity < 0) {
    throw new Error("Target quantity must be a non-negative integer.");
  }
  const resolved = await resolveCollectrItem(env, item);
  if (!resolved.product.id || !resolved.portfolio.id) {
    throw new Error("Collectr product and portfolio are required.");
  }

  const body = {
    subType: resolved.product.subType || item.collectrSubType || item.variance || "",
    gradeId: resolved.product.gradeId || item.collectrGradeId || "",
    quantity: targetQuantity
  };
  await collectrPostJson(
    env,
    "/collections/" + encodeURIComponent(requireCollectrConfig(env).accountId) + "/products/" + encodeURIComponent(resolved.product.id),
    { collectionId: resolved.portfolio.id },
    body
  );
  collectrPortfolioCache = null;
  const refreshedRows = await fetchCollectrProductDetailLines(env, resolved.portfolio.id, resolved.product.id);
  const refreshedMatch = refreshedRows.find((product) =>
    String(product.product_id || "") === String(resolved.product.id || "") &&
    (!body.subType || normalizeCollectrMatchValue(product.product_sub_type) === normalizeCollectrMatchValue(body.subType)) &&
    (!body.gradeId || String(product.grade_id || "") === String(body.gradeId))
  ) || (refreshedRows.length === 1 ? refreshedRows[0] : null);
  const verifiedQuantity = refreshedMatch ? Number(refreshedMatch.quantity || 0) : 0;

  return {
    ...resolved,
    collectr: {
      ...resolved.collectr,
      previousQuantity: resolved.collectr.currentQuantity,
      currentQuantity: verifiedQuantity,
      verifiedQuantity
    },
    targetQuantity,
    verified: verifiedQuantity === targetQuantity
  };
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

async function resolveCollectrCard(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;

  const requestUrl = new URL(request.url);
  const cardId = String(requestUrl.searchParams.get("cardId") || "").trim();
  if (!cardId || cardId.length > 200) {
    return json({ ok: false, error: "A valid Card ID is required." }, 400);
  }

  let item = null;
  const snapshotLookup = getInventorySnapshotLookup(cardId, { allowStale: true });
  if (snapshotLookup) {
    item = snapshotLookup.item;
  }
  if (!item) {
    try {
      await ensureInventorySnapshot(env);
      const freshSnapshotLookup = getInventorySnapshotLookup(cardId, { allowStale: true });
      item = freshSnapshotLookup && freshSnapshotLookup.item;
    } catch (_) {
      item = null;
    }
  }
  if (!item) {
    const lookupResponse = await lookup(request, env);
    const lookupData = await lookupResponse.json();
    if (!lookupResponse.ok || !lookupData.ok) {
      return json({ ok: false, error: lookupData.error || "Inventory lookup failed." }, lookupResponse.status);
    }
    item = lookupData.item;
  }
  if (!item) {
    return json({ ok: false, error: "No spreadsheet row matched " + cardId + "." }, 404);
  }

  try {
    const resolved = await resolveCollectrItem(env, item);
    return json({
      ok: true,
      item,
      ...resolved
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Collectr resolve failed: " + error.message,
      item,
      portfolio: error.portfolio,
      portfolios: error.portfolios
    }, error.status || 502);
  }
}

async function adjustCollectrQuantity(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }
  const cardId = String(payload.cardId || "").trim();
  const targetQuantity = Number(payload.targetQuantity);
  if (!cardId || cardId.length > 200) {
    return json({ ok: false, error: "A valid Card ID is required." }, 400);
  }
  if (!Number.isInteger(targetQuantity) || targetQuantity < 0 || targetQuantity > 9999) {
    return json({ ok: false, error: "Target quantity must be a non-negative integer." }, 400);
  }

  try {
    await ensureInventorySnapshot(env);
    const snapshotLookup = getInventorySnapshotLookup(cardId, { allowStale: true });
    const item = snapshotLookup && snapshotLookup.item;
    if (!item) {
      return json({ ok: false, error: "No spreadsheet row matched " + cardId + "." }, 404);
    }
    const result = await setCollectrItemQuantity(env, item, targetQuantity);
    return json({ ok: true, item, result });
  } catch (error) {
    return json({ ok: false, error: "Collectr quantity update failed: " + error.message }, 502);
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

async function getAuditStatus(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  try {
    const data = await appsScriptGet(env, "audit/status", { threadId: "pwa-audit" });
    const result = data.result || {};
    return json({
      ok: true,
      session: result.session || null,
      scans: Array.isArray(result.scans) ? result.scans : []
    });
  } catch (error) {
    return json({ ok: false, error: "Audit status failed: " + error.message }, 502);
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

function getAuditSummaryStatus(row) {
  if (!row.item) return "not-in-sheet";
  if (row.collectrError) return row.status === "match" ? "collectr-error" : row.status;
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

async function enrichAuditSummaryWithCollectr(env, summary) {
  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  const enrichedRows = [];
  for (const row of rows) {
    const next = {
      ...row,
      collectrQuantity: null,
      collectrDifference: null,
      collectrPortfolioName: "",
      collectrProductId: "",
      collectrWarnings: []
    };
    if (row.item) {
      try {
        const resolved = await resolveCollectrItem(env, row.item);
        next.collectrQuantity = resolved.collectr.currentQuantity;
        next.collectrDifference = Number(row.scannedCount || 0) - Number(resolved.collectr.currentQuantity || 0);
        next.collectrPortfolioName = resolved.portfolio.name;
        next.collectrProductId = resolved.product.id;
        next.collectrWarnings = resolved.warnings;
      } catch (error) {
        next.collectrError = error.message;
      }
    }
    next.status = getAuditSummaryStatus(next);
    enrichedRows.push(next);
  }

  const totals = enrichedRows.reduce((output, row) => {
    output.scannedCount += Number(row.scannedCount || 0);
    output.uniqueCount += 1;
    output.issueCount += row.status === "match" ? 0 : 1;
    output.sheetQuantity += Number(row.sheetQuantity || 0);
    output.collectrQuantity += Number(row.collectrQuantity || 0);
    return output;
  }, {
    scannedCount: 0,
    uniqueCount: 0,
    issueCount: 0,
    sheetQuantity: 0,
    collectrQuantity: 0
  });

  return {
    ...summary,
    rows: enrichedRows,
    totals
  };
}

async function getAuditSummary(request, env) {
  const authorized = isAuthorized(request, env);
  if (!authorized.ok) return authorized.response;
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) return json({ ok: false, error: "Audit session is required." }, 400);
  try {
    const data = await appsScriptPost(env, "audit/summary", { sessionId });
    const summary = await enrichAuditSummaryWithCollectr(env, data.summary);
    return json({ ok: true, summary });
  } catch (error) {
    return json({ ok: false, error: "Audit summary failed: " + error.message }, 502);
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
    if (url.pathname === "/api/collectr/resolve") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);
      return resolveCollectrCard(request, env);
    }
    if (url.pathname === "/api/collectr/quantity") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return adjustCollectrQuantity(request, env);
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
    if (url.pathname === "/api/audit/status") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);
      return getAuditStatus(request, env);
    }
    if (url.pathname === "/api/audit/undo") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return undoAuditScan(request, env);
    }
    if (url.pathname === "/api/audit/summary") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return getAuditSummary(request, env);
    }
    const response = await env.ASSETS.fetch(request);
    const headers = secureAssetHeaders(response.headers);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};

export { safeEqual, normalizeCardId };
