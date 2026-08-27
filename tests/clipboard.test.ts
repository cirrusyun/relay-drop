import assert from "node:assert/strict";
import test from "node:test";
import { settleClipboardWrite } from "../src/clipboard.js";

test("saving preserves newer typing and marks only the submitted version saved", () => {
  assert.deepEqual(settleClipboardWrite("A", "A", "A"), { draft: "A", dirty: false });
  assert.deepEqual(settleClipboardWrite("B", "A", "A"), { draft: "B", dirty: true });
  assert.deepEqual(settleClipboardWrite("", "A", "A"), { draft: "", dirty: true });
});

test("clearing preserves text typed while the request was pending", () => {
  assert.deepEqual(settleClipboardWrite("A", "A", ""), { draft: "", dirty: false });
  assert.deepEqual(settleClipboardWrite("B", "A", ""), { draft: "B", dirty: true });
});
