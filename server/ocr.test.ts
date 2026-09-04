import assert from "node:assert/strict";
import test from "node:test";
import { cleanRecognizedText } from "./ocr.js";

test("OCR output is normalized, bounded, and stripped of control characters", () => {
  assert.equal(cleanRecognizedText("  第一行  \r\nSecond line\f\0\r\n\r\n"), "第一行\nSecond line");
  assert.equal(cleanRecognizedText("x".repeat(210_000)).length, 200_000);
});
