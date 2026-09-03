import assert from "node:assert/strict";
import test from "node:test";
import { clipboardAutosaveDelay, clipboardSyncAction, settleClipboardRead, settleClipboardWrite } from "../src/clipboard.js";

test("saving preserves newer typing and marks only the submitted version saved", () => {
  assert.deepEqual(settleClipboardWrite("A", "A", "A"), { draft: "A", dirty: false });
  assert.deepEqual(settleClipboardWrite("B", "A", "A"), { draft: "B", dirty: true });
  assert.deepEqual(settleClipboardWrite("", "A", "A"), { draft: "", dirty: true });
});

test("autosave waits for pauses, does not interrupt composition or writes, and backs off transient failures", () => {
  const state = { dirty: true, saving: false, composing: false, refreshing: false, failed: false, retryable: true };
  assert.equal(clipboardAutosaveDelay(state), 5000);
  for (const key of ["saving", "composing", "refreshing"] as const) assert.equal(clipboardAutosaveDelay({ ...state, [key]: true }), null);
  assert.equal(clipboardAutosaveDelay({ ...state, dirty: false }), null);
  assert.equal(clipboardAutosaveDelay({ ...state, failed: true }), 10_000);
  assert.equal(clipboardAutosaveDelay({ ...state, failed: true, retryable: false }), null);
  // Native undo changes the draft just like typing; its new value must sync too.
  assert.deepEqual(settleClipboardWrite("before undo", "saved text", "saved text"), { draft: "before undo", dirty: true });
});

test("one sync action saves edits, refreshes clean text, and waits for active writes or composition", () => {
  assert.equal(clipboardSyncAction(true, false, false), "save");
  assert.equal(clipboardSyncAction(false, false, false), "refresh");
  for (const dirty of [true, false]) {
    assert.equal(clipboardSyncAction(dirty, true, false), "wait");
    assert.equal(clipboardSyncAction(dirty, false, true), "wait");
  }
});

test("refresh leaves the input editable and does not overwrite typing or undo during a pending read", () => {
  assert.deepEqual(settleClipboardRead("old", 2, 2, "cloud"), { draft: "cloud", dirty: false });
  assert.deepEqual(settleClipboardRead("typing", 2, 3, "cloud"), { draft: "typing", dirty: true });
  assert.deepEqual(settleClipboardRead("old", 2, 4, "cloud"), { draft: "old", dirty: true });
  assert.deepEqual(settleClipboardRead("cloud", 2, 3, "cloud"), { draft: "cloud", dirty: false });
});

test("clearing preserves text typed while the request was pending", () => {
  assert.deepEqual(settleClipboardWrite("A", "A", ""), { draft: "", dirty: false });
  assert.deepEqual(settleClipboardWrite("B", "A", ""), { draft: "B", dirty: true });
});
