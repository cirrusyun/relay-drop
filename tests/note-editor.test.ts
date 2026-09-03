import assert from "node:assert/strict";
import test from "node:test";
import { canApplyNoteRead, emptyNoteDraft, sameNoteDraft, settleNoteWrite, type Note } from "../src/note-editor.js";

const saved: Note = { id: "a", title: "Title", content: "original", attachments: [], createdAt: "", updatedAt: "" };
const draft = (title: string, content: string, attachments: string[] = []) => ({ title, content, attachments });

test("a delayed note switch never replaces typing, undo, composition, or a newer selection", () => {
  assert.equal(canApplyNoteRead("a", "a", 3, 3, false, false), true);
  assert.equal(canApplyNoteRead("a", "a", 3, 4, true, false), false);
  // Even undoing back to the original value is an edit, not permission to switch.
  assert.equal(canApplyNoteRead("a", "a", 3, 5, false, false), false);
  assert.equal(canApplyNoteRead("a", "a", 3, 3, false, true), false);
  assert.equal(canApplyNoteRead("a", "b", 3, 3, false, false), false);
  assert.equal(canApplyNoteRead("a", undefined, 3, 3, false, false), false);
});

test("refresh replaces only a clean, unchanged editor and ignores reads invalidated on return", () => {
  assert.equal(canApplyNoteRead("a", "a", 6, 6, false, false), true);
  assert.equal(canApplyNoteRead("a", "a", 6, 6, true, false), false);
  assert.equal(canApplyNoteRead("a", "a", 6, 7, false, false), false);
  assert.equal(canApplyNoteRead(undefined, undefined, 0, 0, false, false), true);
});

test("blank new drafts stay local, but a title-only note is meaningful", () => {
  assert.equal(emptyNoteDraft(draft("", "")), true);
  assert.equal(emptyNoteDraft(draft("  ", "\n\t")), true);
  assert.equal(emptyNoteDraft(draft("A title", "")), false);
  assert.equal(emptyNoteDraft(draft("", "一句话")), false);
  assert.equal(emptyNoteDraft(draft("", "", ["image"])), false);
  // Existing notes compare exact values: intentionally clearing one is a save.
  assert.equal(sameNoteDraft(draft("Title", ""), saved), false);
});

test("save responses preserve edits made during both PUT and initial POST", () => {
  assert.deepEqual(settleNoteWrite(saved, saved, saved), draft("Title", "original"));
  for (const content of ["new typing", ""]) {
    const current = draft("Title", content);
    assert.deepEqual(settleNoteWrite(current, saved, saved), current);
    assert.equal(sameNoteDraft(settleNoteWrite(current, saved, saved), saved), false);
  }
  const submitted = draft("", "original");
  assert.deepEqual(settleNoteWrite(submitted, submitted, saved), draft("Title", "original"));
  assert.deepEqual(settleNoteWrite(draft("new title", "original"), submitted, saved), draft("new title", "original"));
});

test("a lost create response cannot roll a newer local draft back to the first attempt", () => {
  const firstAttempt = draft("Title", "original");
  const current = draft("Title", "new local text");
  const afterRetry = settleNoteWrite(current, firstAttempt, saved);
  assert.deepEqual(afterRetry, current);
  assert.equal(sameNoteDraft(afterRetry, saved), false);
  assert.deepEqual(settleNoteWrite(current, current, saved), current);
});

test("attachments are part of note drafts and delayed saves preserve newer image changes", () => {
  const withImage: Note = { ...saved, attachments: ["image-a"] };
  assert.equal(sameNoteDraft(saved, withImage), false);
  assert.equal(sameNoteDraft(draft("Title", "original", ["image-a"]), withImage), true);
  const changedDuringSave = draft("Title", "original", ["image-a", "image-b"]);
  assert.deepEqual(settleNoteWrite(changedDuringSave, withImage, withImage), changedDuringSave);
});
