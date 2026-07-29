const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const { randomUUID } = require("crypto");

let detectorWorker = null;
let detectorSignature = "";

class DetectorWorker {
  constructor(command, args, options) {
    this.pending = new Map();
    this.stderr = "";
    this.dead = false;
    this.process = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => this.onLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8192);
    });
    this.process.on("error", (error) => {
      this.dead = true;
      this.rejectAll(error);
    });
    this.process.on("exit", (code) => {
      this.dead = true;
      this.rejectAll(new Error("Label detector worker exited with code " + code + ". " + this.stderr));
    });
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.error || "Label detector failed."));
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  detect(source, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Label detector timed out."));
        this.process.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.process.stdin.write(JSON.stringify({ id, source }) + "\n");
    });
  }
}

function expandDetection(det, marginRatio = 0.18) {
  const extraX = Math.round(det.width * marginRatio);
  const extraY = Math.round(det.height * marginRatio);
  const x = Math.max(0, det.x - extraX);
  const y = Math.max(0, det.y - extraY);
  const right = Math.min(det.image_width, det.x + det.width + extraX);
  const bottom = Math.min(det.image_height, det.y + det.height + extraY);

  return {
    ...det,
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

async function detectLabels(imagePath, options) {
  const detectorProjectDir = path.resolve(options.detectorProjectDir);
  const pythonExecutable = options.pythonExecutable || "python";
  const predictScript = path.join(detectorProjectDir, "scripts", "predict_server.py");
  const weightsPath = options.weightsPath || path.join(detectorProjectDir, "models", "best.pt");
  const args = [
    predictScript,
    "--weights",
    path.resolve(weightsPath),
    "--imgsz",
    String(options.imageSize || 1280),
    "--conf",
    String(options.confidenceThreshold || 0.2),
    "--device",
    String(options.device || "cpu")
  ];

  const signature = JSON.stringify([pythonExecutable, args, detectorProjectDir]);
  if (!detectorWorker || detectorSignature !== signature || detectorWorker.dead || detectorWorker.process.exitCode !== null) {
    detectorSignature = signature;
    detectorWorker = new DetectorWorker(pythonExecutable, args, { cwd: detectorProjectDir });
  }

  const parsed = await detectorWorker.detect(path.resolve(imagePath), options.timeoutMs || 120000);
  const detections = Array.isArray(parsed.detections) ? parsed.detections : [];
  return detections
    .filter((det) => det.class_name === "label")
    .sort((left, right) => left.y === right.y ? left.x - right.x : left.y - right.y)
    .map((det) => expandDetection(det, options.marginRatio));
}

function shutdownLabelDetector() {
  if (detectorWorker && detectorWorker.process && detectorWorker.process.exitCode === null) {
    detectorWorker.process.kill();
  }
  detectorWorker = null;
  detectorSignature = "";
}

module.exports = {
  detectLabels,
  expandDetection,
  shutdownLabelDetector
};
