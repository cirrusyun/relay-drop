export interface NoteDraft { title: string; content: string; attachments: string[] }
export interface Note extends NoteDraft { id: string; createdAt: string; updatedAt: string }
export interface NoteSummary extends Omit<Note, "content" | "attachments"> { preview: string; characters: number; attachmentCount: number }

export function sameNoteDraft(a: NoteDraft, b: NoteDraft): boolean {
  return a.title === b.title && a.content === b.content
    && a.attachments.length === b.attachments.length
    && a.attachments.every((id, index) => id === b.attachments[index]);
}

export function emptyNoteDraft(draft: NoteDraft): boolean {
  return !draft.title.trim() && !draft.content.trim() && draft.attachments.length === 0;
}

// A read may replace the editor only if nothing changed after it started.
export function canApplyNoteRead(requestedId: string | undefined, currentId: string | undefined, requestedRevision: number, currentRevision: number, dirty: boolean, composing: boolean): boolean {
  return requestedId === currentId && requestedRevision === currentRevision && !dirty && !composing;
}

export function settleNoteWrite(current: NoteDraft, submitted: NoteDraft, saved: Note): NoteDraft {
  // A retried create can return an already-existing note. Keep local text if
  // that response differs from what was submitted; a subsequent PUT saves it.
  return sameNoteDraft(current, submitted) && sameNoteDraft(saved, { ...submitted, title: saved.title })
    ? { title: saved.title, content: saved.content, attachments: [...saved.attachments] }
    : current;
}
