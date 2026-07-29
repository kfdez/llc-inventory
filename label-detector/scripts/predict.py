from __future__ import annotations

import argparse
from pathlib import Path

from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_WEIGHTS = PROJECT_DIR / "runs" / "train" / "label-detector" / "weights" / "best.pt"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run detector inference on images.")
    parser.add_argument("--weights", default=str(DEFAULT_WEIGHTS), help="Path to trained weights.")
    parser.add_argument("--source", default=str(PROJECT_DIR / "datasets" / "raw" / "images"), help="Image or folder to predict on.")
    parser.add_argument("--imgsz", type=int, default=1280, help="Inference image size.")
    parser.add_argument("--conf", type=float, default=0.2, help="Confidence threshold.")
    parser.add_argument("--device", default="0", help="CUDA device id, or cpu.")
    parser.add_argument("--name", default="label-detector-predict", help="Prediction run name.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    model = YOLO(args.weights)
    model.predict(
        source=args.source,
        imgsz=args.imgsz,
        conf=args.conf,
        device=args.device,
        project=str(PROJECT_DIR / "runs" / "predict"),
        name=args.name,
        save=True,
        save_txt=True,
        exist_ok=True,
    )


if __name__ == "__main__":
    main()
