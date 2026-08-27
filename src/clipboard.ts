// A completed request must not mark text typed after that request as saved.
export function settleClipboardWrite(currentDraft: string, submittedDraft: string, savedContent: string) {
  const draft = currentDraft === submittedDraft ? savedContent : currentDraft;
  return { draft, dirty: draft !== savedContent };
}
