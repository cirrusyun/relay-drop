import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { Window } from "happy-dom";
import type { Note } from "../src/note-editor.js";

// In-process component tests only: no real browser, network, or user data.
const dom = new Window({ url: "https://relay.example/", settings: {
  enableJavaScriptEvaluation: false,
  disableJavaScriptFileLoading: true,
  disableCSSFileLoading: true,
  navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
} });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "MouseEvent", "KeyboardEvent", "CompositionEvent", "File", "Blob", "FormData", "XMLHttpRequest", "localStorage"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : dom[key] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: App } = await import("../src/App.js");
after(async () => { await dom.happyDOM.close(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

async function setup(t: TestContext, configure?: (fixture: { notes: Map<string, Note>; control: { before(method: string, url: string, signal?: AbortSignal | null): Promise<void>; failSave: boolean; loseCreateResponse: boolean; files: Array<Record<string, unknown>> } }) => void, notebook = true) {
  dom.happyDOM.setURL(`https://relay.example/${notebook ? "#notebook" : ""}`);
  const notes = new Map<string, Note>(["a", "b"].map((id) => [id, {
    id, title: `Test ${id.toUpperCase()}`, content: `Original ${id.toUpperCase()}`, attachments: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  }]));
  const requests: Array<{ method: string; url: string; body: Record<string, any> }> = [];
  const control = { before: async (_method: string, _url: string, _signal?: AbortSignal | null) => {}, failSave: false, loseCreateResponse: false, files: [] as Array<Record<string, unknown>> };
  configure?.({ notes, control });
  let clipboard = { content: "", updatedAt: null as string | null };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    requests.push({ method, url, body });
    await control.before(method, url, init?.signal);
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (url === "/api/state") return response({ clipboard, files: control.files, limits: { maxUploadBytes: 1000 }, storage: { usedBytes: 0, maxBytes: 20 * 1024 ** 3 } });
    if (url === "/api/clipboard" && method === "PUT") {
      clipboard = { content: body.content, updatedAt: new Date().toISOString() };
      return response({ clipboard });
    }
    if (url === "/api/files/archive" && method === "POST") return response({ url: "/api/files/archive/test-ticket" }, 201);
    if (url === "/api/notes" && method === "GET") return response({ notes: [...notes.values()].map(({ content, attachments, ...note }) => ({ ...note, preview: content, characters: content.length, attachmentCount: attachments.length })) });
    if (url.startsWith("/api/notes")) {
      const id = method === "POST" ? body.id : url.split("/").pop()!;
      if (method === "GET") return notes.has(id) ? response({ note: notes.get(id) }) : response({ error: "Not found" }, 404);
      if (control.failSave) return response({ error: "Test save failed" }, 503);
      if (method === "POST" && notes.has(id)) return response({ note: notes.get(id) });
      if (method === "PUT" && !notes.has(id)) return response({ error: "Not found" }, 404);
      const note: Note = { id, title: body.title?.trim() || body.content.split("\n").find((line) => line.trim()) || "未命名笔记", content: body.content, attachments: body.attachments ?? notes.get(id)?.attachments ?? [], createdAt: notes.get(id)?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes.set(id, note);
      if (method === "POST" && control.loseCreateResponse) {
        control.loseCreateResponse = false;
        return response({ error: "Test create response lost" }, 503);
      }
      return response({ note }, method === "POST" ? 201 : 200);
    }
    throw new Error(`Unexpected test request: ${method} ${url}`);
  }) as typeof fetch;
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => root.render(createElement(App)));
  return { notes, requests, control, container };
}

function field(label: string) {
  const element = dom.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  assert.ok(element, `Missing input: ${label}`);
  return element;
}

async function type(label: string, value: string) {
  await act(async () => {
    const element = field(label);
    const prototype = element.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
}

async function click(selector: string) {
  const element = dom.document.querySelector(selector);
  assert.ok(element, `Missing button: ${selector}`);
  await act(async () => { element.click(); });
  await flush();
}

async function openNote(title: string) {
  const button = [...dom.document.querySelectorAll(".note-item")].find((item) => item.querySelector("strong")?.textContent === title);
  assert.ok(button);
  await act(async () => { button.click(); });
}

const footer = () => dom.document.querySelector(".note-editor-footer")?.textContent;
const editorVisible = () => !dom.document.querySelector(".notebook")?.hasAttribute("hidden");

test("slow note switches preserve newly typed text and a later click saves it before switching", async (t) => {
  const { notes, control } = await setup(t);
  await openNote("Test A");
  const gate = deferred();
  control.before = async (method, url) => { if (method === "GET" && url === "/api/notes/b") await gate.promise; };
  await openNote("Test B");
  assert.equal(field("笔记内容").disabled, false);
  await type("笔记内容", "Typed during loading");
  gate.resolve();
  await flush();
  assert.equal(field("笔记标题").value, "Test A");
  assert.equal(field("笔记内容").value, "Typed during loading");
  assert.match(footer()!, /未保存/);
  await openNote("Test B");
  assert.equal(notes.get("a")?.content, "Typed during loading");
  assert.equal(field("笔记内容").value, "Original B");
});

test("refresh updates the selected note but never replaces dirty text or typing during a refresh", async (t) => {
  const { notes, control } = await setup(t);
  await openNote("Test A");
  notes.set("a", { ...notes.get("a")!, content: "Updated on another device" });
  await click('[aria-label="刷新笔记列表"]');
  assert.equal(field("笔记内容").value, "Updated on another device");
  await type("笔记内容", "Local draft");
  notes.set("a", { ...notes.get("a")!, content: "Another remote update" });
  await click('[aria-label="刷新笔记列表"]');
  assert.equal(field("笔记内容").value, "Local draft");
  await click('.note-editor-actions .primary');
  const gate = deferred();
  control.before = async (method, url) => { if (method === "GET" && url === "/api/notes/a") await gate.promise; };
  await click('[aria-label="刷新笔记列表"]');
  await type("笔记内容", "Typed during refresh");
  gate.resolve();
  await flush();
  assert.equal(field("笔记内容").value, "Typed during refresh");
});

test("both return buttons and hash navigation save edits through the same guard", async (t) => {
  const { notes } = await setup(t);
  for (const [index, selector] of ['[aria-label="返回中转首页"]', '.notebook-heading .ghost', null].entries()) {
    await openNote("Test A");
    await type("笔记内容", `Saved via return ${index}`);
    if (selector) await click(selector);
    else {
      await act(async () => { dom.location.hash = ""; dom.dispatchEvent(new dom.HashChangeEvent("hashchange")); });
      await flush();
    }
    assert.equal(notes.get("a")?.content, `Saved via return ${index}`);
    assert.equal(editorVisible(), false);
    if (index !== 2) await click('[aria-label="打开记事本"]');
  }
});

test("a failed return save keeps the editor, URL, and draft intact, then retries normally", async (t) => {
  const { control, notes } = await setup(t);
  await openNote("Test A");
  await type("笔记内容", "Must stay here");
  control.failSave = true;
  await click('[aria-label="返回中转首页"]');
  assert.equal(editorVisible(), true);
  assert.equal(dom.location.hash, "#notebook");
  assert.equal(field("笔记内容").value, "Must stay here");
  assert.equal(notes.get("a")?.content, "Original A");
  control.failSave = false;
  await click('.notebook-heading .ghost');
  assert.equal(editorVisible(), false);
  assert.equal(notes.get("a")?.content, "Must stay here");
});

test("typing during an active save keeps the latest draft and cancels an unsafe return", async (t) => {
  const { control, notes } = await setup(t);
  await openNote("Test A");
  await type("笔记内容", "Submitted text");
  const gate = deferred();
  control.before = async (method) => { if (method === "PUT") await gate.promise; };
  await click('.note-editor-actions .primary');
  await click('[aria-label="返回中转首页"]');
  await type("笔记内容", "Newer typing");
  gate.resolve();
  await flush();
  assert.equal(editorVisible(), true);
  assert.equal(dom.location.hash, "#notebook");
  assert.equal(field("笔记内容").value, "Newer typing");
  assert.equal(notes.get("a")?.content, "Submitted text");
  await click('[aria-label="返回中转首页"]');
  assert.equal(notes.get("a")?.content, "Newer typing");
  assert.equal(editorVisible(), false);
});

test("new blank notes never create records, while title-only notes save on return", async (t) => {
  const { notes, requests } = await setup(t);
  await click('.notebook-heading .primary');
  await click('[aria-label="返回中转首页"]');
  assert.equal(notes.size, 2);
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
  await click('[aria-label="打开记事本"]');
  await click('.notebook-heading .primary');
  await type("笔记标题", "Title only");
  await click('.notebook-heading .ghost');
  assert.equal(notes.size, 3);
  assert.ok([...notes.values()].some((note) => note.title === "Title only" && note.content === ""));
});

test("retrying a lost create response uses one ID and preserves subsequent edits", async (t) => {
  const { notes, requests, control } = await setup(t);
  await click('.notebook-heading .primary');
  await type("笔记内容", "First draft");
  control.loseCreateResponse = true;
  await click('.note-editor-actions .primary');
  assert.equal(notes.size, 3);
  await type("笔记内容", "Edited after lost response");
  await click('.note-editor-actions .primary');
  assert.equal(notes.size, 3);
  const creates = requests.filter((request) => request.method === "POST");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].body, creates[1].body);
  assert.equal(notes.get(creates[0].body.id)?.content, "Edited after lost response");
  assert.equal(field("笔记内容").value, "Edited after lost response");
  assert.match(footer()!, /已保存/);
});

test("Chinese composition prevents late reads from replacing the editor", async (t) => {
  const { control } = await setup(t);
  await openNote("Test A");
  const gate = deferred();
  control.before = async (method, url) => { if (method === "GET" && url === "/api/notes/b") await gate.promise; };
  await openNote("Test B");
  await act(async () => { field("笔记内容").dispatchEvent(new dom.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event); });
  gate.resolve();
  await flush();
  assert.equal(field("笔记标题").value, "Test A");
  await act(async () => { field("笔记内容").dispatchEvent(new dom.CompositionEvent("compositionend", { bubbles: true, data: "中文" }) as unknown as Event); });
  await type("笔记内容", "中文输入已保留");
  await click('.note-editor-actions .primary');
  assert.equal(field("笔记内容").value, "中文输入已保留");
});

test("note timeouts release the save action and preserve the current draft", async (t) => {
  const { control } = await setup(t);
  await openNote("Test A");
  await type("笔记内容", "Keep on timeout");
  const setTimeout = dom.setTimeout;
  dom.setTimeout = ((handler: () => void, timeout: number) => setTimeout(handler, timeout === 15_000 ? 20 : timeout)) as typeof dom.setTimeout;
  t.after(() => { dom.setTimeout = setTimeout; });
  control.before = async (method, _url, signal) => {
    if (method === "PUT") await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("Test aborted request")), { once: true });
    });
  };
  await click('.note-editor-actions .primary');
  await act(async () => { await new Promise((resolve) => globalThis.setTimeout(resolve, 40)); });
  assert.equal(field("笔记内容").value, "Keep on timeout");
  assert.match(dom.document.querySelector('.notebook-error')?.textContent ?? "", /连接超时/);
  assert.equal(dom.document.querySelector<HTMLButtonElement>('.note-editor-actions .primary')?.disabled, false);
});

test("a manual file refresh takes over an older state read instead of silently doing nothing", async (t) => {
  let first = true;
  const { requests } = await setup(t, ({ control }) => {
    control.before = async (method, url, signal) => {
      if (first && method === "GET" && url === "/api/state") {
        first = false;
        await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("superseded")), { once: true }));
      }
    };
  }, false);
  assert.match(dom.document.body.textContent ?? "", /正在读取/);
  await click('[aria-label="刷新文件列表"]');
  assert.doesNotMatch(dom.document.body.textContent ?? "", /正在读取/);
  assert.equal(dom.document.querySelector<HTMLButtonElement>('[aria-label="刷新文件列表"]')?.disabled, false);
  assert.equal(requests.filter((request) => request.method === "GET" && request.url === "/api/state").length, 2);
});

test("saving the clipboard during the initial read starts a replacement read and releases the file list", async (t) => {
  let first = true;
  const { requests } = await setup(t, ({ control }) => {
    control.before = async (method, url, signal) => {
      if (first && method === "GET" && url === "/api/state") {
        first = false;
        await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled for write")), { once: true }));
      }
    };
  }, false);
  await type("共享剪贴板内容", "Save while loading");
  await click('[aria-label="保存或刷新剪贴板"]');
  await flush();
  assert.doesNotMatch(dom.document.body.textContent ?? "", /正在读取/);
  assert.equal(requests.filter((request) => request.method === "GET" && request.url === "/api/state").length, 2);
});

test("file thumbnails open the same original-image preview while download remains separate", async (t) => {
  const image = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "shared.png", size: 10, mime: "image/png", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: true };
  await setup(t, ({ control }) => { control.files = [image]; }, false);
  await flush();
  assert.equal(dom.document.querySelector<HTMLImageElement>('.file-thumbnail img')?.getAttribute("src"), `/api/files/${image.id}/thumbnail`);
  assert.equal(dom.document.querySelector<HTMLAnchorElement>(`a[aria-label="下载 ${image.name}"]`)?.getAttribute("href"), `/api/files/${image.id}/download`);
  await click('.file-thumbnail-button');
  assert.equal(dom.document.querySelector('.image-lightbox')?.getAttribute("aria-label"), `查看原图 ${image.name}`);
  const preview = dom.document.querySelector<HTMLImageElement>('.image-lightbox img');
  assert.equal(preview?.getAttribute("src"), `/api/files/${image.id}/preview?attempt=0`);
  await act(async () => { preview?.dispatchEvent(new dom.Event("load")); });
  await click('[aria-label="查看原始尺寸"]');
  assert.ok(dom.document.querySelector('.image-lightbox')?.classList.contains("is-zoomed"));
  await click('[aria-label="关闭原图预览"]');
  assert.equal(dom.document.querySelector('.image-lightbox'), null);
});

test("selected files can be downloaded individually or together as a streamed archive", async (t) => {
  const files = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "first.txt", size: 5, mime: "text/plain", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: false },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "second.txt", size: 6, mime: "text/plain", createdAt: "2026-01-02T00:00:00Z", hasThumbnail: false },
  ];
  const downloads: string[] = [];
  const originalClick = dom.HTMLAnchorElement.prototype.click;
  dom.HTMLAnchorElement.prototype.click = function clickDownload() { downloads.push(this.getAttribute("href") ?? ""); };
  t.after(() => { dom.HTMLAnchorElement.prototype.click = originalClick; });
  const { requests } = await setup(t, ({ control }) => { control.files = files; }, false);
  await flush();

  await click('[aria-label="选择 first.txt"]');
  assert.match(dom.document.querySelector(".batch-download")?.textContent ?? "", /下载 1 项/);
  await click(".batch-download");
  assert.deepEqual(downloads, [`/api/files/${files[0].id}/download`]);
  assert.equal(requests.filter((request) => request.url === "/api/files/archive").length, 0);

  await click('[aria-label="选择 second.txt"]');
  assert.match(dom.document.querySelector(".batch-download")?.textContent ?? "", /下载 2 项/);
  await click(".batch-download");
  assert.equal(downloads.at(-1), "/api/files/archive/test-ticket");
  const request = requests.find((item) => item.url === "/api/files/archive");
  assert.equal(request?.method, "POST");
  assert.deepEqual(new Set(request?.body.ids), new Set(files.map((file) => file.id)));
});

test("saved note images render as server thumbnails and unlink without deleting the shared file", async (t) => {
  const image = { id: "image-a", name: "fixture.png", size: 10, mime: "image/png", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: true };
  const { notes, control } = await setup(t, ({ notes, control }) => {
    notes.set("a", { ...notes.get("a")!, attachments: [image.id] });
    control.files = [image];
  });
  await openNote("Test A");
  assert.equal(dom.document.querySelector<HTMLImageElement>('.note-attachment img')?.getAttribute("src"), `/api/files/${image.id}/thumbnail`);
  assert.equal(dom.document.querySelector('.note-attachment span')?.textContent, image.name);
  assert.equal(dom.document.querySelector('.note-attachment a'), null);
  await click('.note-attachment-preview');
  assert.equal(dom.document.querySelector('.image-lightbox')?.getAttribute("role"), "dialog");
  const preview = dom.document.querySelector<HTMLImageElement>('.image-lightbox img');
  assert.equal(preview?.getAttribute("src"), `/api/files/${image.id}/preview?attempt=0`);
  await act(async () => { preview?.dispatchEvent(new dom.Event("load")); });
  await click('[aria-label="查看原始尺寸"]');
  assert.ok(dom.document.querySelector('.image-lightbox')?.classList.contains("is-zoomed"));
  await click('[aria-label="适应窗口"]');
  assert.ok(!dom.document.querySelector('.image-lightbox')?.classList.contains("is-zoomed"));
  await click('[aria-label="关闭原图预览"]');
  assert.equal(dom.document.querySelector('.image-lightbox'), null);
  await click('.note-attachment-remove');
  await click('.note-editor-actions .primary');
  assert.deepEqual(notes.get("a")?.attachments, []);
  assert.equal(control.files.length, 1);
});

test("pasting a screenshot uploads once and immediately persists its note attachment", async (t) => {
  const image = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "pasted.png", size: 10, mime: "image/png", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: true };
  const { notes, control } = await setup(t);
  const originalXHR = globalThis.XMLHttpRequest;
  class FakeXHR {
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    status = 201;
    responseText = JSON.stringify({ file: image });
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    abort() { this.onabort?.(); }
    send() { control.files = [image]; queueMicrotask(() => this.onload?.()); }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXHR });
  t.after(() => { Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: originalXHR }); });
  await openNote("Test A");
  const pasted = new dom.File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" });
  const event = new dom.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items: [{ kind: "file", type: "image/png", getAsFile: () => pasted }] } });
  await act(async () => { field("笔记内容").dispatchEvent(event as unknown as Event); });
  await flush();
  await flush();
  assert.equal(dom.document.querySelector<HTMLImageElement>('.note-attachment img')?.getAttribute("src"), `/api/files/${image.id}/thumbnail`);
  assert.deepEqual(notes.get("a")?.attachments, [image.id]);
  assert.match(dom.document.body.textContent ?? "", /图片已添加并保存/);
  assert.match(footer()!, /已保存/);
  assert.equal(control.files.length, 1);
});
