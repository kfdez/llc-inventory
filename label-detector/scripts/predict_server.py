from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ultralytics import YOLO


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent label detector JSON-lines worker.")
    parser.add_argument("--weights", required=True)
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--conf", type=float, default=0.2)
    parser.add_argument("--device", default="0")
    return parser.parse_args()


def detect(model: YOLO, source: Path, args: argparse.Namespace) -> dict:
    results = model.predict(
        source=str(source),
        imgsz=args.imgsz,
        conf=args.conf,
        device=args.device,
        verbose=False,
        save=False,
        save_txt=False,
    )
    payload = {"source": str(source), "detections": []}
    for result in results:
        names = result.names
        image_height, image_width = result.orig_shape
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            class_id = int(box.cls[0].item())
            payload["detections"].append({
                "class_id": class_id,
                "class_name": names.get(class_id, str(class_id)),
                "confidence": float(box.conf[0].item()),
                "x": max(0, int(round(x1))),
                "y": max(0, int(round(y1))),
                "width": max(1, int(round(x2 - x1))),
                "height": max(1, int(round(y2 - y1))),
                "image_width": int(image_width),
                "image_height": int(image_height),
            })
    return payload


def main() -> None:
    args = parse_args()
    model = YOLO(args.weights)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            source = Path(request["source"]).resolve()
            if not source.exists():
                raise FileNotFoundError(f"Source image not found: {source}")
            response = {"id": request.get("id"), "ok": True, **detect(model, source, args)}
        except Exception as error:  # worker must report per-image failures without exiting
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": str(error),
            }
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
