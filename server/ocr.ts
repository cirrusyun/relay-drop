import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const OCR_TIMEOUT_MS = 25_000;
const OCR_MAX_OUTPUT_BYTES = 1_000_000;
const OCR_MAX_CHARACTERS = 200_000;

function runTesseract(inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "tesseract",
      [inputPath, "stdout", "-l", "chi_sim+eng", "--psm", "6"],
      {
        encoding: "utf8",
        timeout: OCR_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: OCR_MAX_OUTPUT_BYTES,
        env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    );
  });
}

export function cleanRecognizedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\0\f]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .slice(0, OCR_MAX_CHARACTERS);
}

export async function recognizeImageText(filePath: string): Promise<string> {
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "relay-ocr-"));
  const preparedPath = path.join(workingDirectory, "input.png");
  try {
    await sharp(filePath, {
      animated: false,
      failOn: "error",
      limitInputPixels: 24_000_000,
      pages: 1,
    })
      .rotate()
      .resize({ width: 1_800, height: 1_800, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "white" })
      .grayscale()
      .normalise()
      .sharpen()
      .png({ compressionLevel: 6 })
      .toFile(preparedPath);
    return cleanRecognizedText(await runTesseract(preparedPath));
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
