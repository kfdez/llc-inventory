const sharp = require("sharp");
const jsQR = require("jsqr");
const { readBarcodes } = require("zxing-wasm/reader");

function addUnique(found, seen, decoded) {
  if (decoded && !seen[decoded]) {
    seen[decoded] = true;
    found.push(decoded);
  }
}

function addUniqueValues(found, seen, decodedValues) {
  decodedValues.forEach((decoded) => addUnique(found, seen, decoded));
}

function extractTile(data, width, left, top, tileWidth, tileHeight) {
  const tile = new Uint8ClampedArray(tileWidth * tileHeight * 4);
  for (let y = 0; y < tileHeight; y += 1) {
    const sourceStart = ((top + y) * width + left) * 4;
    const sourceEnd = sourceStart + tileWidth * 4;
    tile.set(data.slice(sourceStart, sourceEnd), y * tileWidth * 4);
  }
  return tile;
}

function toRgba(data, info) {
  if (info.channels === 4) {
    return Uint8ClampedArray.from(data);
  }

  const rgba = new Uint8ClampedArray(info.width * info.height * 4);
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const sourceOffset = pixel * info.channels;
    const targetOffset = pixel * 4;
    if (info.channels === 1 || info.channels === 2) {
      const gray = data[sourceOffset];
      rgba[targetOffset] = gray;
      rgba[targetOffset + 1] = gray;
      rgba[targetOffset + 2] = gray;
      rgba[targetOffset + 3] = info.channels === 2 ? data[sourceOffset + 1] : 255;
    } else {
      rgba[targetOffset] = data[sourceOffset];
      rgba[targetOffset + 1] = data[sourceOffset + 1];
      rgba[targetOffset + 2] = data[sourceOffset + 2];
      rgba[targetOffset + 3] = 255;
    }
  }
  return rgba;
}

function tryDecode(data, width, height) {
  const result = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  return result ? String(result.data) : null;
}

async function zxingDecode(imageBuffer) {
  const results = await readBarcodes(imageBuffer, {
    formats: ["QRCode"],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: false,
    tryDenoise: true,
    maxNumberOfSymbols: 0,
    textMode: "Plain"
  });

  return results
    .filter((result) => result.isValid && result.text)
    .map((result) => String(result.text));
}

function collectDirectDecodes(data, width, height) {
  const found = [];
  const seen = {};
  addUnique(found, seen, tryDecode(data, width, height));

  [[2, 1], [1, 2], [2, 2]].forEach(([columns, rows]) => {
    const tileWidth = Math.floor(width / columns);
    const tileHeight = Math.floor(height / rows);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const left = column * tileWidth;
        const top = row * tileHeight;
        const effectiveWidth = column === columns - 1 ? width - left : tileWidth;
        const effectiveHeight = row === rows - 1 ? height - top : tileHeight;
        const tile = extractTile(data, width, left, top, effectiveWidth, effectiveHeight);
        addUnique(found, seen, tryDecode(tile, effectiveWidth, effectiveHeight));
      }
    }
  });

  return found;
}

async function scanQrCodes(imageBuffer) {
  const base = sharp(imageBuffer).rotate();
  const found = [];
  const seen = {};

  const zxingVariants = [
    () => base.clone(),
    () => base.clone().resize({ width: 1200, withoutEnlargement: false, fit: "inside" }).grayscale().normalize().sharpen(),
    () => base.clone().resize({ width: 1600, withoutEnlargement: false, fit: "inside" }).grayscale().threshold(170)
  ];

  for (const builder of zxingVariants) {
    const buffer = await builder().png().toBuffer();
    addUniqueValues(found, seen, await zxingDecode(buffer));
    if (found.length > 1) {
      return found;
    }
  }

  const rawVariants = [
    () => base.clone().resize({ width: 1000, withoutEnlargement: false, fit: "inside" }),
    () => base.clone().resize({ width: 1600, withoutEnlargement: false, fit: "inside" }).grayscale().normalize().sharpen(),
    () => base.clone().resize({ width: 1800, withoutEnlargement: false, fit: "inside" }).grayscale().threshold(160)
  ];

  for (const builder of rawVariants) {
    const variant = await builder()
      .toColorspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    collectDirectDecodes(toRgba(variant.data, variant.info), variant.info.width, variant.info.height)
      .forEach((decoded) => addUnique(found, seen, decoded));
  }

  return found;
}

module.exports = {
  scanQrCodes
};
