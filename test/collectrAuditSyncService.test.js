const assert = require("assert");
const test = require("node:test");
const { AuditCollectrReviewService } = require("../src/collectr/auditReviewService");
const { AuditCollectrSyncService } = require("../src/collectr/auditSyncService");

class MemoryJobStore {
  constructor() {
    this.jobs = [];
  }

  createJob(job) {
    const now = new Date().toISOString();
    const saved = {
      id: "job-" + (this.jobs.length + 1),
      type: job.type,
      state: job.state,
      payload: job.payload || {},
      result: job.result || {},
      error: "",
      attempts: 0,
      notBeforeMs: 0,
      lockedUntilMs: 0,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.push(saved);
    return this.getJob(saved.id);
  }

  getJob(id) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    return job ? JSON.parse(JSON.stringify(job)) : null;
  }

  updateJob(id, patch) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error("Job not found: " + id);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return this.getJob(id);
  }

  claimNextJob({ type, states }) {
    const job = this.jobs.find((candidate) => candidate.type === type && states.includes(candidate.state));
    if (!job) return null;
    job.lockedUntilMs = Date.now() + 45000;
    job.attempts += 1;
    return this.getJob(job.id);
  }

  listJobs({ type }) {
    return this.jobs
      .filter((job) => !type || job.type === type)
      .map((job) => JSON.parse(JSON.stringify(job)));
  }
}

test("audit Collectr sync adds catalog item back to portfolio when not currently owned", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const requestUrl = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({
      method: String(options.method || "GET").toUpperCase(),
      path: requestUrl.pathname,
      query: Object.fromEntries(requestUrl.searchParams.entries()),
      body
    });

    if (requestUrl.pathname === "/catalog") {
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

    if (requestUrl.pathname === "/collections/account-1/products" &&
        requestUrl.searchParams.get("productIds") === "642585") {
      return Response.json({ data: [] });
    }

    if (requestUrl.pathname === "/collections/account-1/products/642585" &&
        String(options.method || "GET").toUpperCase() === "POST") {
      assert.equal(requestUrl.searchParams.get("collectionId"), "portfolio-1");
      assert.deepEqual(body, { subType: "Holofoil", gradeId: "52", quantity: 2 });
      return Response.json({
        productId: "642585",
        subType: "Holofoil",
        gradeId: "52",
        quantity: 2,
        userOwnedProductId: "owned-1"
      });
    }

    if (requestUrl.pathname === "/collections/account-1/products/642585") {
      const posted = requests.some((request) =>
        request.method === "POST" &&
        request.path === "/collections/account-1/products/642585"
      );
      return Response.json({
        data: posted
          ? {
              product_id: "642585",
              product_name: "Crustle ",
              catalog_group: "Black Bolt",
              card_number: "130/086",
              ungraded_sub_types: [{
                product_sub_type: "Holofoil",
                grade_id: "52",
                quantity: "2",
                user_owned_product_id: "owned-1"
              }]
            }
          : {
              product_id: "642585",
              product_name: "Crustle ",
              catalog_group: "Black Bolt",
              card_number: "130/086",
              ungraded_sub_types: []
            }
      });
    }

    return Response.json({ error: "unexpected request" }, { status: 500 });
  });

  const store = new MemoryJobStore();
  const service = new AuditCollectrSyncService({
    store,
    logger: { error() {} },
    config: {
      accountId: "account-1",
      authToken: "Bearer token",
      apiBaseUrl: "https://api-v2.getcollectr.com",
      requestTimeoutMs: 1000
    }
  });

  const job = service.startJob({
    sessionId: "session-1",
    rows: [{
      cardId: "KYL-S-ABC12345",
      targetQuantity: 2,
      collectrSubType: "Holofoil",
      collectrGradeId: "52",
      item: {
        cardId: "KYL-S-ABC12345",
        name: "Crustle",
        setName: "Black Bolt",
        cardNumber: "130/086",
        portfolioName: "Singles",
        collectrCollectionId: "portfolio-1",
        collectrSubType: "Holofoil",
        collectrGradeId: "52"
      }
    }]
  });

  await service.processNext();
  const completed = service.getJob(job.id);

  assert.equal(completed.state, "complete");
  assert.equal(completed.completed, 1);
  assert.equal(completed.rows[0].status, "synced");
  assert.equal(completed.rows[0].collectrProductId, "642585");
  assert.equal(completed.rows[0].collectrQuantity, 2);
  assert.equal(completed.rows[0].verified, true);
  assert.ok(requests.some((request) => request.method === "POST" && request.path === "/collections/account-1/products/642585"));
});

test("starting an audit Collectr review cancels older active review jobs", () => {
  const store = new MemoryJobStore();
  const service = new AuditCollectrReviewService({
    store,
    logger: { error() {} },
    config: {
      accountId: "account-1",
      authToken: "Bearer token",
      apiBaseUrl: "https://api-v2.getcollectr.com",
      requestTimeoutMs: 1000
    }
  });
  const oldRunning = store.createJob({
    type: "audit_collectr_review",
    state: "running",
    payload: { sessionId: "old", fingerprint: "old", total: 1, rows: [] },
    result: { sessionId: "old", total: 1, loaded: 0, rowsById: {} }
  });
  const oldPending = store.createJob({
    type: "audit_collectr_review",
    state: "pending",
    payload: { sessionId: "older", fingerprint: "older", total: 1, rows: [] },
    result: { sessionId: "older", total: 1, loaded: 0, rowsById: {} }
  });

  const job = service.startJob({
    sessionId: "new",
    rows: [{
      cardId: "KYL-S-ABC12345",
      scannedCount: 1,
      sheetQuantity: 1,
      item: {
        cardId: "KYL-S-ABC12345",
        name: "Crustle",
        setName: "Black Bolt",
        cardNumber: "130/086"
      }
    }]
  });

  assert.equal(job.state, "pending");
  assert.equal(store.getJob(oldRunning.id).state, "canceled");
  assert.equal(store.getJob(oldPending.id).state, "canceled");
});
