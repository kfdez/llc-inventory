from __future__ import annotations

import argparse
import json
from pathlib import Path

from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_WEIGHTS = PROJECT_DIR / "runs" / "train" / "label-detector" / "weights" / "best.pt"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run detector inference and emit JSON.")
    parser.add_argument("--weights", default=str(DEFAULT_WEIGHTS), help="Path to trained weights.")
    parser.add_argument("--source", required=True, help="Single image path to predict on.")
    parser.add_argument("--imgsz", type=int, default=1280, help="Inference image size.")
    parser.add_argument("--conf", type=float, default=0.2, help="Confidence threshold.")
    parser.add_argument("--device", default="0", help="CUDA device id, or cpu.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_path = Path(args.source).resolve()
    if not source_path.exists():
        raise SystemExit(f"Source image not found: {source_path}")

    model = YOLO(args.weights)
    results = model.predict(
        source=str(source_path),
        imgsz=args.imgsz,
        conf=args.conf,
        device=args.device,
        verbose=False,
        save=False,
        save_txt=False,
    )

    payload = {
        "source": str(source_path),
        "detections": [],
    }

    for result in results:
        names = result.names
        image_height, image_width = result.orig_shape
        for box in result.boxes:
            xyxy = box.xyxy[0].tolist()
            class_id = int(box.cls[0].item())
            confidence = float(box.conf[0].item())

            x1, y1, x2, y2 = xyxy
            payload["detections"].append({
                "class_id": class_id,
                "class_name": names.get(class_id, str(class_id)),
                "confidence": confidence,
                "x": max(0, int(round(x1))),
                "y": max(0, int(round(y1))),
                "width": max(1, int(round(x2 - x1))),
                "height": max(1, int(round(y2 - y1))),
                "image_width": int(image_width),
                "image_height": int(image_height),
            })

    print(json.dumps(payload))


if __name__ == "__main__":
    main()
