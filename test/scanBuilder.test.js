const test = require("node:test");
const assert = require("node:assert/strict");
const { parseQrPayload, buildCaptureScans } = require("../src/capture/scanBuilder");

test("parses compact QR payload", () => {
  const parsed = parseQrPayload("N=Blue-Eyes White Dragon;O=KYL;C=25;G=S");
  assert.equal(parsed.name, "Blue-Eyes White Dragon");
  assert.equal(parsed.owner, "KYL");
  assert.equal(parsed.cost, "25");
  assert.equal(parsed.category, "Singles");
  assert.equal(parsed.parseStatus, "parsed_compact");
});

test("parses plain card ID payload", () => {
  const parsed = parseQrPayload("KYL-S-ABC12345");
  assert.equal(parsed.cardId, "KYL-S-ABC12345");
  assert.equal(parsed.category, "Singles");
  assert.equal(parsed.parseStatus, "parsed_card_id");
});

test("builds no-code scan row when no QR values are found", () => {
  const scans = buildCaptureScans({
    qrValues: [],
    messageId: "message-1",
    attachmentIndex: 0,
    analysis: { noCodeReason: "No label detections found" }
  });
  assert.equal(scans.length, 1);
  assert.equal(scans[0].parseStatus, "no_code_found");
  assert.equal(scans[0].parseError, "No label detections found");
});
