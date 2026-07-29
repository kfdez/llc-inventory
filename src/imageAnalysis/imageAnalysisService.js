const fs = require("fs/promises");
const sharp = require("sharp");
const { scanQrCodes } = require("./qrScanner");
const { detectLabels } = require("./labelDetector");

function addUnique(found, seen, decoded) {
  if (decoded && !seen[decoded]) {
    seen[decoded] = true;
    found.push(decoded);
  }
}

class ImageAnalysisService {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  async analyzeFile(imagePath) {
    const buffer = await fs.readFile(imagePath);
    return this.analyzeBuffer(buffer, { imagePath });
  }

  async analyzeBuffer(buffer, options = {}) {
    const imagePath = options.imagePath || "";
    if (this.config.labelDetectionEnabled && imagePath) {
      try {
        const labelResult = await this.analyzeWithLabels(buffer, imagePath);
        if (labelResult.qrValues.length) {
          return labelResult;
        }
        const fallbackQrValues = await scanQrCodes(buffer);
        return {
          ...labelResult,
          qrValues: fallbackQrValues,
          fallbackQrValues,
          mode: "label-fallback-full-image",
          noCodeReason: fallbackQrValues.length ? "" : labelResult.noCodeReason
        };
      } catch (error) {
        if (this.logger) {
          this.logger.warn({ err: error }, "Label detection failed; falling back to full-image QR scan.");
        }
        const qrValues = await scanQrCodes(buffer);
        return {
          mode: "full-image-after-label-error",
          qrValues,
          detections: [],
          fallbackQrValues: qrValues,
          labelDetectionError: error.message,
          noCodeReason: qrValues.length ? "" : "Label detection failed and no QR codes decoded"
        };
      }
    }

    const qrValues = await scanQrCodes(buffer);
    return {
      mode: "full-image",
      qrValues,
      detections: [],
      fallbackQrValues: [],
      labelDetectionError: "",
      noCodeReason: qrValues.length ? "" : "No QR codes decoded"
    };
  }

  async analyzeWithLabels(buffer, imagePath) {
    const detections = await detectLabels(imagePath, {
      detectorProjectDir: this.config.detectorProjectDir,
      pythonExecutable: this.config.detectorPython,
      weightsPath: this.config.detectorWeightsPath,
      device: this.config.detectorDevice,
      imageSize: this.config.detectorImageSize,
      confidenceThreshold: this.config.detectorConfidence
    });

    const found = [];
    const seen = {};
    for (const detection of detections) {
      const crop = await sharp(buffer)
        .extract({
          left: detection.x,
          top: detection.y,
          width: detection.width,
          height: detection.height
        })
        .png()
        .toBuffer();
      const decoded = await scanQrCodes(crop);
      decoded.forEach((value) => addUnique(found, seen, value));
    }

    return {
      mode: "label",
      qrValues: found,
      detections,
      fallbackQrValues: [],
      labelDetectionError: "",
      noCodeReason: !detections.length
        ? "No label detections found"
        : (!found.length ? "Labels detected but no QR codes decoded" : "")
    };
  }
}

module.exports = {
  ImageAnalysisService
};
