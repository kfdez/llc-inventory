const pino = require("pino");
const { loadConfig } = require("../config/env");
const { ImageAnalysisService } = require("../imageAnalysis/imageAnalysisService");
const { shutdownLabelDetector } = require("../imageAnalysis/labelDetector");

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error("Usage: npm run demo:analyze -- <image-path>");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const service = new ImageAnalysisService({
    config: config.imageAnalysis,
    logger: pino({ level: config.logLevel })
  });
  const result = await service.analyzeFile(imagePath);
  console.log(JSON.stringify(result, null, 2));
  shutdownLabelDetector();
}

main().catch((error) => {
  shutdownLabelDetector();
  console.error(error);
  process.exitCode = 1;
});
