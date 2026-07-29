from __future__ import annotations

import shutil
from pathlib import Path

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
SOURCE_DIR = PROJECT_DIR.parent / "training-images"
TARGET_DIR = PROJECT_DIR / "datasets" / "raw" / "images"


def main() -> None:
    if not SOURCE_DIR.exists():
        raise SystemExit(f"Source folder not found: {SOURCE_DIR}")

    TARGET_DIR.mkdir(parents=True, exist_ok=True)

    copied = 0
    skipped = 0

    for source_path in sorted(SOURCE_DIR.iterdir()):
        if not source_path.is_file():
            continue
        if source_path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue

        target_path = TARGET_DIR / source_path.name
        if target_path.exists():
            skipped += 1
            continue

        shutil.copy2(source_path, target_path)
        copied += 1

    print(f"source: {SOURCE_DIR}")
    print(f"target: {TARGET_DIR}")
    print(f"copied: {copied}")
    print(f"skipped existing: {skipped}")


if __name__ == "__main__":
    main()
