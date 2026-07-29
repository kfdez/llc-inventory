from __future__ import annotations

import random
import shutil
from pathlib import Path

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
SPLITS = {
    "train": 0.7,
    "val": 0.2,
    "test": 0.1,
}

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
LABELED_IMAGES_DIR = PROJECT_DIR / "datasets" / "labeled" / "images"
LABELED_LABELS_DIR = PROJECT_DIR / "datasets" / "labeled" / "labels"
YOLO_DIR = PROJECT_DIR / "datasets" / "yolo"


def reset_output_dirs() -> None:
    for split_name in SPLITS:
        for kind in ("images", "labels"):
            split_dir = YOLO_DIR / kind / split_name
            if split_dir.exists():
                shutil.rmtree(split_dir)
            split_dir.mkdir(parents=True, exist_ok=True)


def find_labeled_pairs() -> list[tuple[Path, Path]]:
    if not LABELED_IMAGES_DIR.exists():
        raise SystemExit(f"Missing labeled images folder: {LABELED_IMAGES_DIR}")
    if not LABELED_LABELS_DIR.exists():
        raise SystemExit(f"Missing labeled labels folder: {LABELED_LABELS_DIR}")

    pairs: list[tuple[Path, Path]] = []
    for image_path in sorted(LABELED_IMAGES_DIR.iterdir()):
        if not image_path.is_file() or image_path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue

        label_path = LABELED_LABELS_DIR / f"{image_path.stem}.txt"
        if not label_path.exists():
            raise SystemExit(f"Missing label file for {image_path.name}: {label_path}")

        pairs.append((image_path, label_path))

    if not pairs:
        raise SystemExit("No labeled image/label pairs found.")

    return pairs


def split_pairs(pairs: list[tuple[Path, Path]]) -> dict[str, list[tuple[Path, Path]]]:
    random.seed(42)
    shuffled = pairs[:]
    random.shuffle(shuffled)

    total = len(shuffled)
    train_end = int(total * SPLITS["train"])
    val_end = train_end + int(total * SPLITS["val"])

    return {
        "train": shuffled[:train_end],
        "val": shuffled[train_end:val_end],
        "test": shuffled[val_end:],
    }


def copy_split(split_name: str, pairs: list[tuple[Path, Path]]) -> None:
    for image_path, label_path in pairs:
        shutil.copy2(image_path, YOLO_DIR / "images" / split_name / image_path.name)
        shutil.copy2(label_path, YOLO_DIR / "labels" / split_name / label_path.name)


def main() -> None:
    pairs = find_labeled_pairs()
    split_map = split_pairs(pairs)
    reset_output_dirs()

    for split_name, split_pairs_list in split_map.items():
        copy_split(split_name, split_pairs_list)
        print(f"{split_name}: {len(split_pairs_list)}")

    print(f"total: {len(pairs)}")
    print(f"output: {YOLO_DIR}")


if __name__ == "__main__":
    main()
