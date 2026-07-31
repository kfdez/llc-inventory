import test from "node:test";
import assert from "node:assert/strict";
import worker, { normalizeCardId, safeEqual } from "../src/worker.js";

test("safeEqual accepts identical non-empty PINs", () => {
  assert.equal(safeEqual("482913", "482913"), true);
});

test("safeEqual rejects missing and different PINs", () => {
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual("482913", "482914"), false);
  assert.equal(safeEqual("123", "1234"), false);
});

test("normalizeCardId trims and uppercases card IDs", () => {
  assert.equal(normalizeCardId(" al-s-e51f26cf "), "AL-S-E51F26CF");
});

test("session endpoint rejects missing configuration", async () => {
  const response = await worker.fetch(new Request("https://scanner.test/api/session"), {}, {});
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.ok, false);
});

test("session endpoint rejects an incorrect PIN", async () => {
  const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
  const response = await worker.fetch(new Request("https://scanner.test/api/session", {
    headers: { "X-App-Pin": "000000" }
  }), env, {});
  const data = await response.json();
  assert.equal(response.status, 401);
  assert.equal(data.ok, false);
});

test("lookup validates cardId before calling Apps Script", async () => {
  const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
  const response = await worker.fetch(new Request("https://scanner.test/api/lookup", {
    headers: { "X-App-Pin": "482913" }
  }), env, {});
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.equal(data.ok, false);
});

test("POST-only endpoints reject wrong methods", async () => {
  const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
  const response = await worker.fetch(new Request("https://scanner.test/api/audit/start", {
    method: "GET",
    headers: { "X-App-Pin": "482913" }
  }), env, {});
  const data = await response.json();
  assert.equal(response.status, 405);
  assert.equal(data.ok, false);
});

test("audit scan forwards card ID in the Apps Script scan payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    assert.equal(body.path, "audit/scan");
    assert.equal(body.payload.sessionId, "session-1");
    assert.equal(body.payload.scans[0].cardId, "AL-S-E51F26CF");
    assert.equal(body.payload.scans[0].recordKey, "record-1");
    return Response.json({
      ok: true,
      result: {
        appended: 1,
        updated: 0,
        sheetTabName: "Audit Log - Test",
        recordKey: "record-1"
      }
    });
  };

  try {
    const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
    const response = await worker.fetch(new Request("https://scanner.test/api/audit/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Pin": "482913" },
      body: JSON.stringify({
        sessionId: "session-1",
        cardId: "AL-S-E51F26CF",
        recordKey: "record-1"
      })
    }), env, {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.result.recordKey, "record-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("audit status returns the active Apps Script audit session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.searchParams.get("path"), "audit/status");
    assert.equal(requestUrl.searchParams.get("threadId"), "pwa-audit");
    return Response.json({
      ok: true,
      result: {
        session: {
          session_id: "session-1",
          session_name: "Inventory audit",
          sheet_tab_name: "Audit Log - Inventory audit",
          thread_id: "pwa-audit",
          status: "active"
        },
        scans: [{
          cardId: "AL-S-E51F26CF",
          recordKey: "record-1",
          status: "active"
        }]
      }
    });
  };

  try {
    const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
    const response = await worker.fetch(new Request("https://scanner.test/api/audit/status", {
      headers: { "X-App-Pin": "482913" }
    }), env, {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.session.session_id, "session-1");
    assert.equal(data.scans[0].recordKey, "record-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("audit summary returns sheet review before Collectr enrichment", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.host, "script.example");

    if (requestUrl.searchParams.get("path") === "audit/status") {
      assert.equal(requestUrl.searchParams.get("sessionId"), "session-1");
      return Response.json({
        ok: true,
        result: {
          session: { session_id: "session-1" },
          scans: [{
            cardId: "KYL-S-ABC12345",
            status: "active",
            recordKey: "record-1"
          }]
        }
      });
    }

    if (requestUrl.searchParams.get("path") === "inventory/lookup-snapshot") {
      return Response.json({
        ok: true,
        snapshot: {
          itemsById: {
            "KYL-S-ABC12345": {
              cardId: "KYL-S-ABC12345",
              portfolioName: "KYL",
              setName: "Black Bolt",
              name: "Crustle",
              cardNumber: "130/086",
              quantity: 1
            }
          }
        }
      });
    }

    throw new Error("Unexpected fetch: " + requestUrl.toString());
  };

  try {
    const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
    const response = await worker.fetch(new Request("https://scanner.test/api/audit/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Pin": "482913" },
      body: JSON.stringify({ sessionId: "session-1" })
    }), env, {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.summary.rows[0].cardId, "KYL-S-ABC12345");
    assert.equal(data.summary.rows[0].collectrPending, true);
    assert.equal(data.summary.rows[0].collectrLoaded, false);
    assert.equal(data.summary.collectr.pendingCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("audit summary falls back to Apps Script summary when status has no session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.host, "script.example");

    if (requestUrl.searchParams.get("path") === "audit/status") {
      return Response.json({ ok: true, result: { session: null, scans: [] } });
    }

    const body = JSON.parse(options.body);
    if (body.path === "audit/summary") {
      assert.equal(body.payload.sessionId, "session-1");
      return Response.json({
        ok: true,
        summary: {
          session: { session_id: "session-1" },
          rows: [{
            cardId: "KYL-S-ABC12345",
            scannedCount: 1,
            sheetQuantity: 1,
            status: "match",
            item: { cardId: "KYL-S-ABC12345" }
          }]
        }
      });
    }

    throw new Error("Unexpected fetch: " + requestUrl.toString());
  };

  try {
    const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
    const response = await worker.fetch(new Request("https://scanner.test/api/audit/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Pin": "482913" },
      body: JSON.stringify({ sessionId: "session-1" })
    }), env, {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.summary.rows[0].collectrPending, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectr resolve requires Collectr configuration after inventory lookup", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.searchParams.get("path"), "inventory/lookup-snapshot");
    return Response.json({
      ok: true,
      snapshot: {
        itemsById: {
          "KYL-S-ABC12345": {
            cardId: "KYL-S-ABC12345",
            portfolioName: "KYL",
            setName: "Black Bolt",
            name: "Crustle",
            cardNumber: "130/086",
            variance: "Holofoil"
          }
        }
      }
    });
  };

  try {
    const env = { APP_PIN: "482913", APPS_SCRIPT_API_BASE_URL: "https://script.example/exec" };
    const response = await worker.fetch(new Request("https://scanner.test/api/collectr/resolve?cardId=KYL-S-ABC12345", {
      headers: { "X-App-Pin": "482913" }
    }), env, {});
    const data = await response.json();
    assert.equal(response.status, 502);
    assert.equal(data.ok, false);
    assert.match(data.error, /Collectr is not configured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectr resolve maps portfolio by name and product by catalog search", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    calls.push(requestUrl.toString());

    if (requestUrl.host === "script.example") {
      return Response.json({
        ok: true,
        snapshot: {
          itemsById: {
            "KYL-S-ABC12345": {
              cardId: "KYL-S-ABC12345",
              portfolioName: "KYL",
              setName: "Black Bolt",
              name: "Crustle",
              cardNumber: "130/086",
              variance: "Holofoil"
            }
          }
        }
      });
    }

    if (requestUrl.pathname.endsWith("/collections")) {
      return Response.json({ data: [{ id: "portfolio-1", name: "KYL" }] });
    }

    if (requestUrl.pathname === "/catalog") {
      assert.equal(requestUrl.searchParams.get("searchString"), "Black Bolt\tCrustle\t130/086");
      return Response.json({
        data: [{
          product_id: "642585",
          catalog_group: "Black Bolt",
          product_name: "Crustle ",
          card_number: "130/086",
          product_sub_type: "Holofoil"
        }]
      });
    }

    if (requestUrl.pathname.endsWith("/products")) {
      assert.equal(requestUrl.searchParams.get("collectionId"), "portfolio-1");
      assert.equal(requestUrl.searchParams.get("productIds"), "642585");
      return Response.json({
        data: [{
          product_id: "642585",
          user_owned_product_id: "owned-1",
          quantity: "2",
          grade_id: "52",
          product_sub_type: "Holofoil"
        }]
      });
    }

    if (requestUrl.pathname === "/collections/account-1/products/642585") {
      return Response.json({
        data: {
          product_id: "642585",
          product_name: "Crustle ",
          catalog_group: "Black Bolt",
          card_number: "130/086",
          ungraded_sub_types: [{
            product_sub_type: "Holofoil",
            grade_id: "52",
            quantity: 2,
            user_owned_product_id: "owned-1"
          }]
        }
      });
    }

    throw new Error("Unexpected fetch: " + requestUrl.toString());
  };

  try {
    const env = {
      APP_PIN: "482913",
      APPS_SCRIPT_API_BASE_URL: "https://script.example/exec",
      COLLECTR_ACCOUNT_ID: "account-1",
      COLLECTR_AUTH_TOKEN: "token-value",
      COLLECTR_API_BASE_URL: "https://api-v2.getcollectr.com",
      COLLECTR_CURRENCY: "CAD"
    };
    const response = await worker.fetch(new Request("https://scanner.test/api/collectr/resolve?cardId=KYL-S-ABC12345", {
      headers: { "X-App-Pin": "482913" }
    }), env, {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.portfolio.id, "portfolio-1");
    assert.equal(data.portfolio.source, "collectr-name");
    assert.equal(data.product.id, "642585");
    assert.equal(data.product.source, "catalog-exact");
    assert.equal(data.collectr.currentQuantity, 2);
    assert.ok(calls.some((call) => call.includes("/accounts/account-1/collections")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectr resolve can call Collectr through the VPS proxy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));

    if (requestUrl.host === "script.example") {
      return Response.json({
        ok: true,
        snapshot: {
          itemsById: {
            "KYL-S-ABC12345": {
              cardId: "KYL-S-ABC12345",
              portfolioName: "KYL",
              setName: "Black Bolt",
              name: "Crustle",
              cardNumber: "130/086",
              variance: "Holofoil"
            }
          }
        }
      });
    }

    if (requestUrl.host === "proxy.example") {
      assert.equal(requestUrl.pathname, "/llc-inventory-v2-collectr/collectr/api");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-Collectr-Proxy-Secret"], "proxy-secret");
      const body = JSON.parse(options.body);
      if (body.path.endsWith("/collections")) {
        return Response.json({ ok: true, data: { data: [{ id: "portfolio-1", name: "KYL" }] } });
      }
      if (body.path === "/catalog") {
        return Response.json({
          ok: true,
          data: {
            data: [{
              product_id: "642585",
              catalog_group: "Black Bolt",
              product_name: "Crustle ",
              card_number: "130/086",
              product_sub_type: "Holofoil"
            }]
          }
        });
      }
      if (body.path === "/collections/account-1/products/642585") {
        return Response.json({
          ok: true,
          data: {
            data: {
              product_id: "642585",
              product_name: "Crustle ",
              catalog_group: "Black Bolt",
              card_number: "130/086",
              ungraded_sub_types: [{
                product_sub_type: "Holofoil",
                grade_id: "52",
                quantity: 3,
                user_owned_product_id: "owned-1"
              }]
            }
          }
        });
      }
      if (body.path.endsWith("/products")) {
        return Response.json({
          ok: true,
          data: {
            data: [{
              product_id: "642585",
              user_owned_product_id: "owned-1",
              quantity: "3",
              grade_id: "52",
              product_sub_type: "Holofoil"
            }]
          }
        });
      }
    }

    throw new Error("Unexpected fetch: " + requestUrl.toString());
  };

  try {
    const env = {
      APP_PIN: "482913",
      APPS_SCRIPT_API_BASE_URL: "https://script.example/exec",
      COLLECTR_ACCOUNT_ID: "account-1",
      COLLECTR_PROXY_BASE_URL: "https://proxy.example/llc-inventory-v2-collectr/",
      COLLECTR_PROXY_SECRET: "proxy-secret",
      COLLECTR_CURRENCY: "CAD"
    };
    const response = await worker.fetch(new Request("https://scanner.test/api/collectr/resolve?cardId=KYL-S-ABC12345", {
      headers: { "X-App-Pin": "482913" }
    }), env, {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.portfolio.id, "portfolio-1");
    assert.equal(data.product.id, "642585");
    assert.equal(data.collectr.currentQuantity, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectr quantity update posts target quantity through the VPS proxy", async () => {
  const originalFetch = globalThis.fetch;
  const proxyBodies = [];
  let wroteQuantity = false;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));

    if (requestUrl.host === "script.example") {
      assert.equal(requestUrl.searchParams.get("path"), "inventory/lookup-snapshot");
      return Response.json({
        ok: true,
        snapshot: {
          itemsById: {
            "KYL-S-ABC12345": {
              cardId: "KYL-S-ABC12345",
              portfolioName: "KYL",
              setName: "Black Bolt",
              name: "Crustle",
              cardNumber: "130/086",
              variance: "Holofoil"
            }
          }
        }
      });
    }

    if (requestUrl.host === "proxy.example") {
      const body = JSON.parse(options.body);
      proxyBodies.push(body);
      if (body.path.endsWith("/collections")) {
        return Response.json({ ok: true, data: { data: [{ id: "portfolio-1", name: "KYL" }] } });
      }
      if (body.path === "/catalog") {
        return Response.json({
          ok: true,
          data: {
            data: [{
              product_id: "642585",
              catalog_group: "Black Bolt",
              product_name: "Crustle ",
              card_number: "130/086",
              product_sub_type: "Holofoil"
            }]
          }
        });
      }
      if (body.path === "/collections/account-1/products" && body.method !== "POST") {
        return Response.json({
          ok: true,
          data: {
            data: [{
              product_id: "642585",
              user_owned_product_id: "owned-1",
              quantity: wroteQuantity ? "4" : "1",
              grade_id: "52",
              product_sub_type: "Holofoil"
            }]
          }
        });
      }
      if (body.path === "/collections/account-1/products/642585" && body.method !== "POST") {
        return Response.json({
          ok: true,
          data: {
            data: {
              product_id: "642585",
              product_name: "Crustle ",
              catalog_group: "Black Bolt",
              card_number: "130/086",
              ungraded_sub_types: [{
                product_sub_type: "Holofoil",
                grade_id: "52",
                quantity: wroteQuantity ? 4 : 1,
                user_owned_product_id: "owned-1"
              }]
            }
          }
        });
      }
      if (body.path === "/collections/account-1/products/642585") {
        assert.equal(body.method, "POST");
        assert.equal(body.query.collectionId, "portfolio-1");
        assert.deepEqual(body.body, { subType: "Holofoil", gradeId: "52", quantity: 4 });
        wroteQuantity = true;
        return Response.json({ ok: true, data: { ok: true } });
      }
    }

    throw new Error("Unexpected fetch: " + requestUrl.toString());
  };

  try {
    const env = {
      APP_PIN: "482913",
      APPS_SCRIPT_API_BASE_URL: "https://script.example/exec",
      COLLECTR_ACCOUNT_ID: "account-1",
      COLLECTR_PROXY_BASE_URL: "https://proxy.example/llc-inventory-v2-collectr/",
      COLLECTR_PROXY_SECRET: "proxy-secret",
      COLLECTR_CURRENCY: "CAD"
    };
    const response = await worker.fetch(new Request("https://scanner.test/api/collectr/quantity", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Pin": "482913" },
      body: JSON.stringify({ cardId: "KYL-S-ABC12345", targetQuantity: 4 })
    }), env, {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.result.collectr.previousQuantity, 1);
    assert.equal(data.result.collectr.currentQuantity, 4);
    assert.equal(data.result.collectr.verifiedQuantity, 4);
    assert.equal(data.result.verified, true);
    assert.ok(proxyBodies.some((body) => body.path === "/collections/account-1/products/642585" && body.method === "POST"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
