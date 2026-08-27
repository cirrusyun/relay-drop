import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildApp } from "./index.js";
import { normalizeFilename, RelayStore } from "./store.js";

function upload(content: string | Buffer, name = "file.txt", mime = "text/plain") {
  const boundary = `relay-security-${randomUUID()}`;
  return {
    method: "POST" as const, url: "/api/files",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
      Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
const disk = { minFreeDiskBytes: 0, freeDiskBytes: async () => 100 * 1024 * 1024 };

test("Unicode filenames and header-control characters cannot break downloads", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-filename-security-"));
  const app = await buildApp({ dataDir, serveFrontend: false, ...disk });
  try {
    assert.equal(normalizeFilename("../../file.txt"), "file.txt");
    assert.equal(normalizeFilename("..\\..\\file.txt"), "file.txt");
    assert.doesNotThrow(() => encodeURIComponent(normalizeFilename("x".repeat(179) + "😀")));
    const added = await app.inject(upload("unchanged content"));
    const id = added.json().file.id;
    for (const name of ["x".repeat(179) + "😀", "bad\ud800name.txt", "header\r\nX-Injected: yes.html", "../../<script>.html"]) {
      const renamed = await app.inject({ method: "PATCH", url: `/api/files/${id}`, payload: { name } });
      assert.equal(renamed.statusCode, 200);
      const download = await app.inject(`/api/files/${id}/download`);
      assert.equal(download.statusCode, 200);
      assert.equal(download.body, "unchanged content");
      assert.equal(download.headers["content-type"], "application/octet-stream");
      assert.match(String(download.headers["content-disposition"]), /^attachment;/);
      assert.equal(download.headers["x-injected"], undefined);
      assert.equal(download.headers["x-content-type-options"], "nosniff");
    }
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("active documents and MIME-spoofed images are saved only as downloadable attachments", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-document-security-"));
  const app = await buildApp({ dataDir, serveFrontend: false, ...disk });
  try {
    for (const [content, name, mime] of [
      ['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>', "disguised.png", "image/png"],
      ["%PDF-1.7\nfixture", "disguised.jpg", "image/jpeg"],
      ["<html><script>alert('fixture')</script></html>", "page.html", "text/html"],
    ]) {
      const result = await app.inject(upload(content, name, mime));
      assert.equal(result.statusCode, 201);
      assert.equal(result.json().file.hasThumbnail, false);
      const id = result.json().file.id;
      assert.equal((await app.inject(`/api/files/${id}/thumbnail`)).statusCode, 404);
      assert.equal((await app.inject(`/api/files/${id}/preview`)).statusCode, 404);
      const download = await app.inject(`/api/files/${id}/download`);
      assert.equal(download.body, content);
      assert.match(String(download.headers["content-disposition"]), /^attachment;/);
      assert.equal(download.headers["content-type"], "application/octet-stream");
    }
    assert.deepEqual(await readdir(path.join(dataDir, "thumbnails")), []);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("all supported raster image signatures still produce small thumbnails", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-raster-security-"));
  const app = await buildApp({ dataDir, serveFrontend: false, ...disk });
  try {
    for (const format of ["png", "jpeg", "gif", "webp", "avif"] as const) {
      const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).toFormat(format).toBuffer();
      const result = await app.inject(upload(bytes, `fixture.${format}`, `image/${format}`));
      assert.equal(result.statusCode, 201, format);
      assert.equal(result.json().file.hasThumbnail, true, format);
      const thumbnail = await app.inject(`/api/files/${result.json().file.id}/thumbnail`);
      assert.equal(thumbnail.statusCode, 200);
      assert.ok(thumbnail.rawPayload.length < 10_000);
    }
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("oversized and concurrent uploads cannot exceed quotas or leave partial files", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-quota-security-"));
  const app = await buildApp({ dataDir, serveFrontend: false, maxUploadBytes: 10, maxStorageBytes: 10, ...disk });
  try {
    assert.equal((await app.inject(upload("x".repeat(11)))).statusCode, 413);
    assert.deepEqual(await readdir(path.join(dataDir, "files")), []);
    const concurrent = await Promise.all([app.inject(upload("123456")), app.inject(upload("abcdef"))]);
    assert.deepEqual(concurrent.map((reply) => reply.statusCode).sort(), [201, 507]);
    const state = (await app.inject("/api/state")).json();
    assert.equal(state.files.length, 1);
    assert.equal(state.storage.usedBytes, 6);
    assert.equal((await readdir(path.join(dataDir, "files"))).length, 1);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("malformed paths, invalid deletions and cross-site mutations cannot alter stored content", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-path-security-"));
  const app = await buildApp({ dataDir, serveFrontend: false, ...disk });
  try {
    const added = await app.inject(upload("kept"));
    const id = added.json().file.id;
    for (const url of ["/api/files/..%2Fstate.json/download", "/api/files/%2Fetc%2Fpasswd/download", "/api/files/not-an-id/thumbnail"]) {
      assert.equal((await app.inject(url)).statusCode, 404);
    }
    for (const ids of [["../state.json"], [null], "not-an-array", [], [id, { id }]]) {
      assert.equal((await app.inject({ method: "DELETE", url: "/api/files", payload: { ids } })).statusCode, 400);
    }
    for (const [method, url, payload] of [
      ["DELETE", `/api/files/${id}`, undefined],
      ["DELETE", "/api/files", { ids: [id] }],
      ["PATCH", `/api/files/${id}`, { name: "changed" }],
      ["DELETE", "/api/clipboard", undefined],
    ] as const) {
      const result = await app.inject({ method, url, payload, headers: { origin: "https://untrusted.example" } });
      assert.equal(result.statusCode, 403);
    }
    assert.equal((await app.inject(`/api/files/${id}/download`)).body, "kept");
    const state = await app.inject("/api/state");
    assert.equal(state.json().files.length, 1);
    assert.equal(state.headers["access-control-allow-origin"], undefined);
    assert.equal(state.headers["cache-control"], "private, no-store");
    assert.equal(state.headers["x-frame-options"], "DENY");
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("symlinks are not served and private metadata cannot leak through the file API", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-symlink-security-"));
  const store = new RelayStore(dataDir);
  await store.init();
  const storedName = randomUUID();
  await writeFile(path.join(dataDir, "private-fixture.txt"), "private fixture");
  await symlink(path.join(dataDir, "private-fixture.txt"), path.join(store.filesDir, storedName));
  const record = await store.addFile({ name: "fixture.txt", storedName, size: 15, mime: "text/plain", createdAt: new Date().toISOString(), expiresAt: null, uploadKey: randomUUID(), internalNote: "not for API" } as Parameters<typeof store.addFile>[0]);
  const app = await buildApp({ dataDir, serveFrontend: false, ...disk });
  try {
    assert.equal((await app.inject(`/api/files/${record.id}/download`)).statusCode, 404);
    const file = (await app.inject("/api/state")).json().files[0];
    for (const key of ["storedName", "uploadKey", "internalNote"]) assert.equal(key in file, false);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
