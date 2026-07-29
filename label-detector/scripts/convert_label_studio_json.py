from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path
from urllib.parse import unquote, urlparse

CLASS_MAP = {
    "label": 0,
}

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_EXPORT_JSON = PROJECT_DIR / "label-studio-export.json"
RAW_IMAGES_DIR = PROJECT_DIR / "datasets" / "raw" / "images"
LABELED_IMAGES_DIR = PROJECT_DIR / "datasets" / "labeled" / "images"
LABELED_LABELS_DIR = PROJECT_DIR / "datasets" / "labeled" / "labels"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert Label Studio JSON export to YOLO labels.")
    parser.add_argument(
        "--input",
        default=str(DEFAULT_EXPORT_JSON),
        help="Path to the Label Studio JSON export file.",
    )
    parser.add_argument(
        "--raw-images",
        default=str(RAW_IMAGES_DIR),
        help="Folder containing the original raw images.",
    )
    parser.add_argument(
        "--clear",
        action="store_true",
        help="Clear labeled image/label outputs before conversion.",
    )
    return parser.parse_args()


def ensure_clean_dir(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for child in directory.iterdir():
        if child.name == ".gitkeep":
            continue
        if child.is_file():
            child.unlink()


def decode_image_name(image_value: str) -> str:
    parsed = urlparse(str(image_value))
    candidate = parsed.path or str(image_value)
    return Path(unquote(candidate)).name


def normalize_label_studio_name(image_name: str) -> str:
    name = Path(str(image_name)).name

    if re.match(r"^[0-9a-fA-F]{8}-", name):
        name = name.split("-", 1)[1]

    stem = Path(name).stem
    suffix = Path(name).suffix

    stem = stem.replace("_", " ")
    stem = re.sub(r"\s+\((\d+)\)$", r" (\1)", stem)
    stem = re.sub(r"\s+(\d+)$", r" (\1)", stem)

    return f"{stem}{suffix}"


def build_raw_image_index(raw_images_dir: Path) -> dict[str, Path]:
    index: dict[str, Path] = {}
    for image_path in raw_images_dir.iterdir():
        if not image_path.is_file():
            continue
        index[image_path.name] = image_path
    return index


def clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def convert_box(result: dict) -> tuple[int, float, float, float, float] | None:
    value = result.get("value") or {}
    labels = value.get("rectanglelabels") or []
    if not labels:
        return None

    class_name = str(labels[0]).strip()
    if class_name not in CLASS_MAP:
        return None

    x = float(value.get("x", 0.0))
    y = float(value.get("y", 0.0))
    width = float(value.get("width", 0.0))
    height = float(value.get("height", 0.0))

    x_center = clamp((x + (width / 2.0)) / 100.0)
    y_center = clamp((y + (height / 2.0)) / 100.0)
    width_norm = clamp(width / 100.0)
    height_norm = clamp(height / 100.0)

    return (CLASS_MAP[class_name], x_center, y_center, width_norm, height_norm)


def extract_results(task: dict) -> list[dict]:
    annotations = task.get("annotations") or []
    if not annotations:
        return []

    results = annotations[0].get("result") or []
    return [result for result in results if result.get("type") == "rectanglelabels"]


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).resolve()
    raw_images_dir = Path(args.raw_images).resolve()

    if not input_path.exists():
        raise SystemExit(f"Label Studio export not found: {input_path}")
    if not raw_images_dir.exists():
        raise SystemExit(f"Raw images folder not found: {raw_images_dir}")

    raw_image_index = build_raw_image_index(raw_images_dir)

    LABELED_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    LABELED_LABELS_DIR.mkdir(parents=True, exist_ok=True)

    if args.clear:
        ensure_clean_dir(LABELED_IMAGES_DIR)
        ensure_clean_dir(LABELED_LABELS_DIR)

    tasks = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(tasks, list):
        raise SystemExit("Expected a Label Studio JSON export containing a list of tasks.")

    converted = 0
    skipped = 0

    for task in tasks:
        data = task.get("data") or {}
        image_value = data.get("image")
        if not image_value:
            skipped += 1
            continue

        image_name = decode_image_name(image_value)
        normalized_image_name = normalize_label_studio_name(image_name)
        source_image = raw_image_index.get(image_name) or raw_image_index.get(normalized_image_name)
        if source_image is None:
            skipped += 1
            print(f"missing source image: {image_name} -> {normalized_image_name}")
            continue

        results = extract_results(task)
        boxes = []
        for result in results:
            converted_box = convert_box(result)
            if converted_box is not None:
                boxes.append(converted_box)

        if not boxes:
            skipped += 1
            continue

        target_image = LABELED_IMAGES_DIR / source_image.name
        target_label = LABELED_LABELS_DIR / f"{source_image.stem}.txt"

        shutil.copy2(source_image, target_image)
        label_lines = [
            f"{class_id} {x_center:.6f} {y_center:.6f} {width:.6f} {height:.6f}"
            for class_id, x_center, y_center, width, height in boxes
        ]
        target_label.write_text("\n".join(label_lines) + "\n", encoding="utf-8")
        converted += 1

    print(f"input: {input_path}")
    print(f"raw images: {raw_images_dir}")
    print(f"converted: {converted}")
    print(f"skipped: {skipped}")
    print(f"labeled images: {LABELED_IMAGES_DIR}")
    print(f"labeled labels: {LABELED_LABELS_DIR}")


if __name__ == "__main__":
    main()
