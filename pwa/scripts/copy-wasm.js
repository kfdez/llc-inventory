import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectDir, "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm");
const destination = resolve(projectDir, "public/zxing_reader.wasm");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log("Copied ZXing WebAssembly runtime.");
