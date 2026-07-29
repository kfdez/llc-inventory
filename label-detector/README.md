# Label Detector

This is a separate Python project for the `AI Label Detection` import mode.

Goal:
- detect the white sticker labels in event photos
- crop those label regions
- pass those crops back into the existing QR decoder in the Node bot

The Node bot is not calling this model yet. This project is the training and inference workspace we will use to build that detector.

## Recommended Stack

- Python 3.11
- NVIDIA CUDA-enabled PyTorch on your RTX 3070
- Ultralytics YOLO for object detection
- One class only: `label`

## Folder Layout

```text
label-detector/
  README.md
  requirements.txt
  dataset.yaml
  scripts/
    check_cuda.py
    bootstrap_raw_images.py
    convert_label_studio_json.py
    split_yolo_dataset.py
    train.py
    predict.py
  datasets/
    raw/
      images/
    labeled/
      images/
      labels/
    yolo/
      images/
        train/
        val/
        test/
      labels/
        train/
        val/
        test/
  runs/
```

## Step 1: Create the Python Environment

From the repo root:

```powershell
cd "F:\Coding Projects\llc-inventory\label-detector"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
```

Install CUDA-enabled PyTorch first. Use the official command from [pytorch.org](https://pytorch.org/get-started/locally/) for your Windows/CUDA version.

Then install the project requirements:

```powershell
pip install -r requirements.txt
```

Check GPU visibility:

```powershell
python .\scripts\check_cuda.py
```

## Step 2: Copy Raw Images Into the Detector Workspace

This project expects your original training images from:

```text
F:\Coding Projects\llc-inventory\training-images
```

Bootstrap them into `datasets/raw/images`:

```powershell
python .\scripts\bootstrap_raw_images.py
```

## Step 3: Label the Sticker Labels

Class list:

- `label`

Bounding box rules:
- draw a box around the full white sticker label
- include whatever is printed on that sticker
- this may be:
  - QR + printed ID
  - initials only
  - QR + initials
- keep the box tight but do not crop off edges
- label partially visible labels only if the label itself is still clearly visible
- skip labels that are too blurred to be useful

Class definition:

- `label` = the physical white inventory sticker attached to the card or sleeve

Important:
- the detector is learning the sticker region itself
- it is not limited to only the newest QR-based labels
- older initials-only labels should still be annotated as `label`

Recommended labeling tools:
- CVAT
- Label Studio
- LabelImg

Recommended export path if you use Label Studio:

1. Export annotations as `JSON`
2. Save that export as:

```text
F:\Coding Projects\llc-inventory\label-detector\label-studio-export.json
```

3. Convert it into YOLO labels:

```powershell
python .\scripts\convert_label_studio_json.py --clear
```

This will populate:

```text
datasets/labeled/images
datasets/labeled/labels
```

If you are not using Label Studio, any YOLO detection export is fine as long as the image filenames and label filenames match.

## Step 4: Split the Labeled Dataset

Once labels exist, build the YOLO train/val/test structure:

```powershell
python .\scripts\split_yolo_dataset.py
```

Default split:
- train: 70%
- val: 20%
- test: 10%

## Step 5: Train the Detector

Start with a small model:

```powershell
python .\scripts\train.py --model yolov8n.pt --epochs 100 --imgsz 1280
```

You can also try:
- `yolov8s.pt` for a slightly stronger model

## Step 6: Run Inference On Sample Images

```powershell
python .\scripts\predict.py --source ".\datasets\raw\images"
```

Predictions will be written under `runs/predict/...`.

## What We Need Before Bot Integration

The model is ready to integrate when:

1. it consistently finds the sticker labels in your real event photos
2. false negatives are low
3. the crops are tight enough that QR decoding works reliably on them

Then we add a Node-facing inference bridge so the `AI Label Detection` mode in the bot can:

1. call the detector
2. get label bounding boxes
3. crop those regions
4. run the existing QR decoder on the crops

## Suggested First Milestone

Use your current 90 images as the first annotation batch.

That is enough to:
- prove the labeling format
- train an initial detector
- check whether label-first detection beats classic full-image QR scanning
