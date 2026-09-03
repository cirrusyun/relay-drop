import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import sharp from "sharp";
import { buildApp } from "./index.js";

const disk = { minFreeDiskBytes: 0, freeDiskBytes: async () => 100 * 1024 * 1024 };

function upload(content: string | Buffer, name = "file.txt", mime = "text/plain") {
  const boundary = `relay-note-${randomUUID()}`;
  return {
    method: "POST" as const, url: "/api/files",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
      Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("notebook snapshots stay independent of clipboard, are editable, and survive restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-notebook-test-"));
  const options = { dataDir, serveFrontend: false, ...disk };
  let app = await buildApp(options);
  try {
    await app.inject({ method: "PUT", url: "/api/clipboard", payload: { content: "first line\noriginal text" } });
    const before = await readFile(path.join(dataDir, "state.json"), "utf8");
    const id = randomUUID();
    const created = await app.inject({ method: "POST", url: "/api/notes", payload: { id, content: "first line\noriginal text" } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().note.title, "first line");
    assert.equal(await readFile(path.join(dataDir, "state.json"), "utf8"), before);
    await app.inject({ method: "PUT", url: "/api/clipboard", payload: { content: "clipboard changed" } });
    assert.equal((await app.inject(`/api/notes/${id}`)).json().note.content, "first line\noriginal text");
    const edited = await app.inject({ method: "PUT", url: `/api/notes/${id}`, payload: { title: "My note", content: "edited note" } });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().note.createdAt, created.json().note.createdAt);
    assert.deepEqual(edited.json().note.attachments, []);
    // A lost create response retried later cannot roll back an edit.
    const retried = await app.inject({ method: "POST", url: "/api/notes", payload: { id, content: "first line\noriginal text" } });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().note.content, "edited note");
    // Older note files did not have an attachments field. They remain readable
    // without a bulk migration or startup rewrite.
    const noteFile = path.join(dataDir, "notes", `${id}.json`);
    const legacy = JSON.parse(await readFile(noteFile, "utf8"));
    delete legacy.attachments;
    await writeFile(noteFile, `${JSON.stringify(legacy)}\n`);
    await app.close();
    app = await buildApp(options);
    const list = await app.inject("/api/notes");
    assert.equal(list.headers["cache-control"], "private, no-store");
    assert.equal(list.json().notes.length, 1);
    assert.equal("content" in list.json().notes[0], false);
    assert.equal(list.json().notes[0].title, "My note");
    assert.equal((await app.inject(`/api/notes/${id}`)).json().note.content, "edited note");
    assert.deepEqual((await app.inject(`/api/notes/${id}`)).json().note.attachments, []);
    assert.equal((await app.inject("/api/state")).json().clipboard.content, "clipboard changed");
    assert.equal((await stat(path.join(dataDir, "notes", `${id}.json`))).mode & 0o777, 0o600);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/notes/${id}` })).statusCode, 204);
    assert.equal((await app.inject(`/api/notes/${id}`)).statusCode, 404);
    assert.equal((await app.inject("/api/state")).json().storage.usedBytes, 0);
    assert.equal((await app.inject("/api/state")).json().clipboard.content, "clipboard changed");
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("notes attach existing raster images without copying file bytes", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-notebook-images-"));
  const app = await buildApp({ dataDir, serveFrontend: false, ...disk });
  try {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    const image = (await app.inject(upload(png, "note.png", "image/png"))).json().file;
    const text = (await app.inject(upload("not an image"))).json().file;
    const before = (await app.inject("/api/state")).json().storage.usedBytes;
    const created = await app.inject({ method: "POST", url: "/api/notes", payload: { content: "with image", attachments: [image.id] } });
    assert.equal(created.statusCode, 201);
    const id = created.json().note.id;
    assert.deepEqual(created.json().note.attachments, [image.id]);
    assert.equal((await app.inject("/api/notes")).json().notes[0].attachmentCount, 1);
    assert.equal("attachments" in (await app.inject("/api/notes")).json().notes[0], false);
    assert.equal((await app.inject("/api/state")).json().storage.usedBytes - before, (await stat(path.join(dataDir, "notes", `${id}.json`))).size);

    // A cached pre-attachment client omits the field; it must preserve links.
    const oldClient = await app.inject({ method: "PUT", url: `/api/notes/${id}`, payload: { title: "old client edit", content: "updated" } });
    assert.deepEqual(oldClient.json().note.attachments, [image.id]);
    for (const attachments of [[text.id], [randomUUID()], [image.id, image.id], Array.from({ length: 31 }, () => randomUUID())]) {
      assert.equal((await app.inject({ method: "PUT", url: `/api/notes/${id}`, payload: { content: "bad", attachments } })).statusCode, 400);
      assert.deepEqual((await app.inject(`/api/notes/${id}`)).json().note.attachments, [image.id]);
    }
    const detached = await app.inject({ method: "PUT", url: `/api/notes/${id}`, payload: { content: "updated", attachments: [] } });
    assert.deepEqual(detached.json().note.attachments, []);
    assert.equal((await app.inject(`/api/files/${image.id}/download`)).statusCode, 200);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("notes share the storage quota, failed writes preserve existing notes, shrinking releases space", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-notebook-quota-"));
  const app = await buildApp({ dataDir, serveFrontend: false, maxStorageBytes: 600, ...disk });
  try {
    const first = await app.inject({ method: "POST", url: "/api/notes", payload: { title: "kept", content: "x".repeat(200) } });
    assert.equal(first.statusCode, 201);
    const id = first.json().note.id;
    const used = (await app.inject("/api/state")).json().storage.usedBytes;
    assert.equal(used, (await stat(path.join(dataDir, "notes", `${id}.json`))).size);
    const failed = await app.inject({ method: "PUT", url: `/api/notes/${id}`, payload: { content: "x".repeat(1000) } });
    assert.equal(failed.statusCode, 507);
    assert.equal((await app.inject(`/api/notes/${id}`)).json().note.content, "x".repeat(200));
    assert.equal((await app.inject("/api/state")).json().storage.usedBytes, used);
    assert.equal((await app.inject({ method: "PUT", url: `/api/notes/${id}`, payload: { title: "kept", content: "x" } })).statusCode, 200);
    assert.ok((await app.inject("/api/state")).json().storage.usedBytes < used);
    assert.deepEqual(await readdir(path.join(dataDir, "notes")), [`${id}.json`]);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("note operations reject invalid input and cross-site writes without touching user content", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-notebook-security-"));
  const app = await buildApp({ dataDir, serveFrontend: false, ...disk });
  try {
    for (const payload of [{ id: "../../state.json", content: "bad" }, { content: 42 }, { content: "ok", title: {} }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/notes", payload })).statusCode, 400);
    }
    const created = await app.inject({ method: "POST", url: "/api/notes", payload: { content: "kept" } });
    const id = created.json().note.id;
    for (const [method, url] of [["POST", "/api/notes"], ["PUT", `/api/notes/${id}`], ["DELETE", `/api/notes/${id}`]] as const) {
      assert.equal((await app.inject({ method, url, headers: { origin: "https://untrusted.example" }, payload: { content: "changed" } })).statusCode, 403);
    }
    assert.equal((await app.inject("/api/notes/..%2fstate.json")).statusCode, 404);
    assert.equal((await app.inject(`/api/notes/${id}`)).json().note.content, "kept");
    assert.equal((await app.inject({ method: "PUT", url: `/api/notes/${randomUUID()}`, payload: { content: "cannot recreate" } })).statusCode, 404);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
