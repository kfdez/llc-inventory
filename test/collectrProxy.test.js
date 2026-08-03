const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCollectrUrl, isAllowedCollectrPath, safeEqual } = require("../src/collectr/proxyServer");

test("safeEqual accepts matching non-empty proxy secrets", () => {
  assert.equal(safeEqual("secret-value", "secret-value"), true);
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual("secret-value", "other-value"), false);
});

test("Collectr proxy only allows expected read paths", () => {
  assert.equal(isAllowedCollectrPath("/accounts/account-1/collections"), true);
  assert.equal(isAllowedCollectrPath("/collections/account-1/products"), true);
  assert.equal(isAllowedCollectrPath("/collections/account-1/products/642585"), true);
  assert.equal(isAllowedCollectrPath("/collections/account-1/products/owned/owned-1/purchase-prices"), true);
  assert.equal(isAllowedCollectrPath("/catalog"), true);
  assert.equal(isAllowedCollectrPath("/collections/account-1/products/123/history"), false);
  assert.equal(isAllowedCollectrPath("/collections/account-1/products/owned/owned-1/history"), false);
  assert.equal(isAllowedCollectrPath("/accounts/account-1/profile"), false);
});

test("buildCollectrUrl preserves path and query values", () => {
  const url = buildCollectrUrl({
    apiBaseUrl: "https://api-v2.getcollectr.com"
  }, "/catalog", {
    username: "account-1",
    searchString: "Black Bolt\tCrustle\t130/086",
    limit: 30
  });

  assert.equal(url.origin, "https://api-v2.getcollectr.com");
  assert.equal(url.pathname, "/catalog");
  assert.equal(url.searchParams.get("username"), "account-1");
  assert.equal(url.searchParams.get("searchString"), "Black Bolt\tCrustle\t130/086");
  assert.equal(url.searchParams.get("limit"), "30");
});
