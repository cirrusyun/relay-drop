// A completed request must not mark text typed after that request as saved.
export function settleClipboardWrite(currentDraft: string, submittedDraft: string, savedContent: string) {
  const draft = currentDraft === submittedDraft ? savedContent : currentDraft;
  return { draft, dirty: draft !== savedContent };
}

// Refreshing never locks the editor. Preserve edits made after the read began,
// including typing followed by undo back to the original value.
export function settleClipboardRead(currentDraft: string, requestedRevision: number, currentRevision: number, cloudContent: string) {
  const draft = requestedRevision === currentRevision ? cloudContent : currentDraft;
  return { draft, dirty: draft !== cloudContent };
}

export function clipboardSyncAction(dirty: boolean, busy: boolean, composing: boolean): "wait" | "save" | "refresh" {
  return busy || composing ? "wait" : dirty ? "save" : "refresh";
}

export function clipboardAutosaveDelay(state: { dirty: boolean; saving: boolean; composing: boolean; refreshing: boolean; failed: boolean; retryable: boolean }): number | null {
  if (!state.dirty || state.saving || state.composing || state.refreshing || (state.failed && !state.retryable)) return null;
  return state.failed ? 10_000 : 5000;
}
