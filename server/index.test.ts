import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import { buildApp } from "./index.js";

test("shared clipboard, file lifecycle, safe names, and storage quota", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-test-"));
  const app = await buildApp({
    dataDir,
    maxUploadBytes: 300_000,
    maxStorageBytes: 200_000,
    serveFrontend: false,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const initial = await fetch(`${address}/api/state`);
    assert.equal(initial.status, 200);
    const initialState = await initial.json() as any;
    assert.deepEqual(initialState.clipboard, { content: "", updatedAt: null });
    assert.deepEqual(initialState.storage, { usedBytes: 0, maxBytes: 200_000 });
    assert.equal(initial.headers.get("x-content-type-options"), "nosniff");

    const clipboard = await fetch(`${address}/api/clipboard`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "ssh root@example.com" }),
    });
    assert.equal(clipboard.status, 200);
    const clipboardResult = await clipboard.json() as any;
    assert.equal(clipboardResult.clipboard.content, "ssh root@example.com");
    assert.ok(clipboardResult.clipboard.updatedAt);

    const firstBody = new FormData();
    firstBody.append("file", new Blob(["hello"], { type: "text/plain" }), "../../evil.txt");
    const firstUpload = await fetch(`${address}/api/files`, {
      method: "POST",
      body: firstBody,
    });
    assert.equal(firstUpload.status, 201);
    const uploaded = await firstUpload.json() as any;
    assert.equal(uploaded.file.name, "evil.txt");
    assert.equal(uploaded.file.size, 5);
    assert.equal(uploaded.file.expiresAt, null);
    assert.equal("storedName" in uploaded.file, false);

    const emptyRename = await fetch(`${address}/api/files/${uploaded.file.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(emptyRename.status, 400);

    const renamed = await fetch(`${address}/api/files/${uploaded.file.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../../renamed.txt" }),
    });
    assert.equal(renamed.status, 200);
    const renamedResult = await renamed.json() as any;
    assert.equal(renamedResult.file.name, "renamed.txt");
    assert.equal("storedName" in renamedResult.file, false);

    const download = await fetch(`${address}/api/files/${uploaded.file.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") || "", /^attachment;/);
    assert.match(download.headers.get("content-disposition") || "", /renamed\.txt/);
    assert.equal(await download.text(), "hello");

    const removedPreview = await fetch(`${address}/api/files/${uploaded.file.id}/preview`);
    assert.equal(removedPreview.status, 404);

    const png = await sharp({
      create: { width: 8, height: 6, channels: 3, background: { r: 73, g: 130, b: 230 } },
    }).png().toBuffer();
    const imageBody = new FormData();
    imageBody.append("file", new Blob([png], { type: "image/png" }), "thumbnail.png");
    const imageUpload = await fetch(`${address}/api/files`, { method: "POST", body: imageBody });
    assert.equal(imageUpload.status, 201);
    const image = await imageUpload.json() as any;
    assert.equal(image.file.hasThumbnail, true);

    const thumbnail = await fetch(`${address}/api/files/${image.file.id}/thumbnail`);
    assert.equal(thumbnail.status, 200);
    assert.equal(thumbnail.headers.get("content-type"), "image/webp");
    assert.equal(thumbnail.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(thumbnail.headers.get("x-content-type-options"), "nosniff");
    assert.equal(thumbnail.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    const thumbnailBytes = (await thumbnail.arrayBuffer()).byteLength;
    assert.ok(thumbnailBytes > 0 && thumbnailBytes < 10_000);

    const withThumbnail = await (await fetch(`${address}/api/state`)).json() as any;
    assert.equal(withThumbnail.files.find((file: any) => file.id === image.file.id).hasThumbnail, true);
    assert.equal(withThumbnail.storage.usedBytes, 5 + png.length + thumbnailBytes);

    const missingThumbnail = await fetch(`${address}/api/files/${uploaded.file.id}/thumbnail`);
    assert.equal(missingThumbnail.status, 404);

    const secondBody = new FormData();
    secondBody.append("file", new Blob([Buffer.alloc(200_000)], { type: "text/plain" }), "second.txt");
    const secondUpload = await fetch(`${address}/api/files`, {
      method: "POST",
      body: secondBody,
    });
    assert.equal(secondUpload.status, 507);

    const afterQuota = await (await fetch(`${address}/api/state`)).json() as any;
    assert.equal(afterQuota.files.length, 2);
    assert.equal(afterQuota.storage.usedBytes, 5 + png.length + thumbnailBytes);
    assert.deepEqual(
      (await readdir(path.join(dataDir, "files"))).filter((name) => name.endsWith(".uploading")),
      [],
    );

    const bulkDeleted = await fetch(`${address}/api/files`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [uploaded.file.id, image.file.id] }),
    });
    assert.equal(bulkDeleted.status, 200);
    const bulkResult = await bulkDeleted.json() as any;
    assert.deepEqual(new Set(bulkResult.removedIds), new Set([uploaded.file.id, image.file.id]));
    assert.deepEqual(bulkResult.storage, { usedBytes: 0, maxBytes: 200_000 });
    const finalState = await (await fetch(`${address}/api/state`)).json() as any;
    assert.equal(finalState.files.length, 0);
    assert.equal(finalState.storage.usedBytes, 0);
    assert.deepEqual(await readdir(path.join(dataDir, "files")), []);
    assert.deepEqual(await readdir(path.join(dataDir, "thumbnails")), []);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
