const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ImageAnalysisService } = require("../src/imageAnalysis/imageAnalysisService");

test("analyzes a QR image with full-image fallback scanner", async () => {
  const service = new ImageAnalysisService({
    config: {
      labelDetectionEnabled: false
    },
    logger: { warn() {} }
  });
  const result = await service.analyzeFile(
    path.resolve(__dirname, "../test-assets/test-qr-single.png")
  );
  assert.equal(result.mode, "full-image");
  assert.ok(result.qrValues.length >= 1);
});
