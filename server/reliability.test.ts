import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "./index.js";
import { RelayStore } from "./store.js";

const MiB = 1024 * 1024;
const enoughDisk = async () => 100 * MiB;
function uploadBody(content: string | Buffer = "hello", name = "file.txt") {
  const boundary = "relay-test-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("writes allow the real origin and CLI, reject cross-site requests without changing data", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-origin-test-"));
  const app = await buildApp({ dataDir, serveFrontend: false, minFreeDiskBytes: 0, freeDiskBytes: enoughDisk });
  try {
    for (const headers of [
      { host: "drop.example.com", origin: "https://evil.example", "x-forwarded-proto": "https" },
      { host: "drop.example.com", origin: "null" },
      { host: "drop.example.com", "sec-fetch-site": "cross-site" },
      { host: "drop.example.com", origin: "http://drop.example.com", "x-forwarded-proto": "https" },
    ]) {
      const result = await app.inject({ method: "PUT", url: "/api/clipboard", headers, payload: { content: "rejected" } });
      assert.equal(result.statusCode, 403);
    }
    const crossSiteFile = await app.inject({ method: "POST", url: "/api/files", ...uploadBody(), headers: { ...uploadBody().headers, origin: "https://evil.example" } });
    assert.equal(crossSiteFile.statusCode, 403);
    const untouched = await app.inject("/api/state");
    assert.equal(untouched.json().clipboard.content, "");
    assert.equal(untouched.json().files.length, 0);
    assert.equal(untouched.headers["cache-control"], "private, no-store");
    const trusted = await app.inject({ method: "PUT", url: "/api/clipboard", headers: { host: "drop.example.com", origin: "https://drop.example.com", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" }, payload: { content: "trusted" } });
    assert.equal(trusted.statusCode, 200);
    const cli = await app.inject({ method: "PUT", url: "/api/clipboard", payload: { content: "cli" } });
    assert.equal(cli.statusCode, 200);
    const trustedFile = await app.inject({ method: "POST", url: "/api/files", ...uploadBody(), headers: { ...uploadBody().headers, host: "drop.example.com", origin: "https://drop.example.com", "x-forwarded-proto": "https" } });
    assert.equal(trustedFile.statusCode, 201);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("upload retries are deduplicated across requests and restarts; new uploads remain distinct", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-retry-test-"));
  const options = { dataDir, serveFrontend: false, minFreeDiskBytes: 0, freeDiskBytes: enoughDisk };
  let app = await buildApp(options);
  try {
    const key = randomUUID();
    const request = { method: "POST" as const, url: "/api/files", ...uploadBody(), headers: { ...uploadBody().headers, "idempotency-key": key } };
    const first = await app.inject(request);
    assert.equal(first.statusCode, 201);
    assert.equal("uploadKey" in first.json().file, false);
    const retry = await app.inject(request);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().file.id, first.json().file.id);
    assert.equal((await app.inject("/api/state")).json().storage.usedBytes, 5);
    await app.close();
    app = await buildApp(options);
    const restartedRetry = await app.inject(request);
    assert.equal(restartedRetry.json().file.id, first.json().file.id);
    const newUpload = await app.inject({ ...request, headers: { ...request.headers, "idempotency-key": randomUUID() } });
    assert.equal(newUpload.statusCode, 201);
    assert.notEqual(newUpload.json().file.id, first.json().file.id);
    const invalidKey = await app.inject({ ...request, headers: { ...request.headers, "idempotency-key": "../../bad" } });
    assert.equal(invalidKey.statusCode, 400);
    assert.equal((await app.inject("/api/state")).json().files.length, 2);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("concurrent requests with the same upload key cannot create two files", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-concurrent-test-"));
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = await buildApp({ dataDir, serveFrontend: false, minFreeDiskBytes: 0, freeDiskBytes: async () => { entered(); await gate; return 100 * MiB; } });
  try {
    const request = { method: "POST" as const, url: "/api/files", ...uploadBody(), headers: { ...uploadBody().headers, "idempotency-key": randomUUID() } };
    const first = app.inject(request);
    await started;
    const overlapping = await app.inject(request);
    assert.equal(overlapping.statusCode, 409);
    assert.equal(overlapping.json().code, "UPLOAD_IN_PROGRESS");
    release();
    assert.equal((await first).statusCode, 201);
    assert.equal((await app.inject(request)).statusCode, 200);
    assert.equal((await app.inject("/api/state")).json().files.length, 1);
  } finally { release(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("low disk space refuses uploads, preserves clipboard usage, and releases retry keys", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-disk-test-"));
  let free = 10 * MiB;
  const app = await buildApp({ dataDir, serveFrontend: false, minFreeDiskBytes: 10 * MiB, freeDiskBytes: async () => free });
  try {
    const request = { method: "POST" as const, url: "/api/files", ...uploadBody(), headers: { ...uploadBody().headers, "idempotency-key": randomUUID() } };
    assert.equal((await app.inject(request)).statusCode, 507);
    assert.equal((await app.inject("/api/state")).json().storage.usedBytes, 0);
    assert.deepEqual(await readdir(path.join(dataDir, "files")), []);
    assert.equal((await app.inject({ method: "PUT", url: "/api/clipboard", payload: { content: "still usable" } })).statusCode, 200);
    free = 100 * MiB;
    assert.equal((await app.inject(request)).statusCode, 201);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("disk space is checked again during upload and failed uploads leave no files or quota", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-disk-stream-test-"));
  let checks = 0;
  const app = await buildApp({ dataDir, serveFrontend: false, minFreeDiskBytes: 10 * MiB, freeDiskBytes: async () => ++checks === 1 ? 100 * MiB : 0 });
  try {
    const result = await app.inject({ method: "POST", url: "/api/files", ...uploadBody(Buffer.alloc(2 * MiB)) });
    assert.equal(result.statusCode, 507);
    assert.ok(checks > 1);
    assert.deepEqual(await readdir(path.join(dataDir, "files")), []);
    assert.equal((await app.inject("/api/state")).json().storage.usedBytes, 0);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("an interrupted HTTP upload cleans partial bytes and the same key can retry", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-interrupted-test-"));
  const app = await buildApp({ dataDir, serveFrontend: false, minFreeDiskBytes: 0, freeDiskBytes: enoughDisk });
  let connection: ReturnType<typeof httpRequest> | undefined;
  try {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const key = randomUUID();
    connection = httpRequest(`${address}/api/files`, {
      method: "POST", headers: { ...uploadBody().headers, "idempotency-key": key },
    });
    connection.on("error", () => undefined);
    connection.write(Buffer.concat([
      Buffer.from('--relay-test-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\n'),
      Buffer.alloc(16 * 1024),
    ]));
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readdir(path.join(dataDir, "files"))).length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await readdir(path.join(dataDir, "files"))).length, 1);
    connection.destroy();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await readdir(path.join(dataDir, "files"))).length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(await readdir(path.join(dataDir, "files")), []);
    assert.equal((await app.inject("/api/state")).json().storage.usedBytes, 0);
    const retry = await app.inject({ method: "POST", url: "/api/files", ...uploadBody(), headers: { ...uploadBody().headers, "idempotency-key": key } });
    assert.equal(retry.statusCode, 201);
    assert.equal((await app.inject("/api/state")).json().storage.usedBytes, 5);
  } finally {
    connection?.destroy();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("startup reconciles sizes, recovers originals, and only removes recognized incomplete files", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-recovery-test-"));
  const store = new RelayStore(dataDir);
  await store.init();
  try {
    const storedName = randomUUID();
    await writeFile(path.join(store.filesDir, storedName), "kept");
    await store.addFile({ name: "kept.txt", storedName, size: 999, mime: "text/plain", createdAt: new Date().toISOString(), expiresAt: null });
    await store.saveClipboard("keep this clipboard");
    const orphan = randomUUID();
    await writeFile(path.join(store.filesDir, orphan), "recovered");
    await writeFile(path.join(store.filesDir, `${randomUUID()}.uploading`), "partial");
    await writeFile(path.join(store.thumbnailsDir, `${randomUUID()}.webp.uploading`), "partial");
    await writeFile(`${store.statePath}.${randomUUID()}.tmp`, "partial state");
    await writeFile(path.join(store.filesDir, "keep.uploading"), "unknown");
    const restarted = new RelayStore(dataDir);
    await restarted.init();
    const report = await restarted.reconcileStorage();
    assert.equal(report.temporaryFilesRemoved, 3);
    assert.equal(report.recoveredFiles, 1);
    assert.equal(restarted.snapshot().clipboard.content, "keep this clipboard");
    assert.equal(restarted.snapshot().files.find((file) => file.storedName === storedName)?.size, 4);
    assert.ok(restarted.snapshot().files.some((file) => file.storedName === orphan && file.expiresAt === null));
    assert.equal(await readFile(path.join(store.filesDir, "keep.uploading"), "utf8"), "unknown");
    assert.equal(await restarted.storageBytes(), 4 + 9 + 7);
    const app = await buildApp({ dataDir, serveFrontend: false, maxStorageBytes: 21, minFreeDiskBytes: 0, freeDiskBytes: enoughDisk });
    try {
      assert.equal((await app.inject("/api/state")).json().storage.usedBytes, 20);
      assert.equal((await app.inject({ method: "POST", url: "/api/files", ...uploadBody() })).statusCode, 507);
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("failed persistence does not change live state or remove a user's file", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-persist-test-"));
  const store = new RelayStore(dataDir);
  await store.init();
  try {
    await store.saveClipboard("A");
    const storedName = randomUUID();
    await writeFile(path.join(store.filesDir, storedName), "original");
    const file = await store.addFile({ name: "file.txt", storedName, size: 8, mime: "text/plain", createdAt: new Date().toISOString(), expiresAt: null });
    const persist = (store as any).persist;
    (store as any).persist = async () => { throw new Error("simulated disk write failure"); };
    await assert.rejects(store.saveClipboard("B"));
    assert.equal(store.snapshot().clipboard.content, "A");
    await assert.rejects(store.deleteFiles([file.id]));
    assert.equal(store.snapshot().files.length, 1);
    assert.equal(await readFile(store.filePath(file), "utf8"), "original");
    (store as any).persist = persist;
    await store.reconcileStorage();
    assert.equal(await readFile(store.filePath(file), "utf8"), "original");
    assert.deepEqual(await readdir(store.deletionsDir), []);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("restart finishes committed deletions instead of recovering deleted files", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-delete-recovery-test-"));
  const store = new RelayStore(dataDir);
  await store.init();
  try {
    const removed = randomUUID();
    await writeFile(path.join(store.filesDir, removed), "already deleted in state");
    await writeFile(path.join(store.thumbnailsDir, `${removed}.webp`), "thumbnail");
    await writeFile(path.join(store.deletionsDir, `${removed}.json`), "{}");
    const report = await store.reconcileStorage();
    assert.equal(report.completedDeletes, 1);
    assert.equal(report.recoveredFiles, 0);
    assert.equal(await store.storageBytes(), 0);
    assert.deepEqual(await readdir(store.deletionsDir), []);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
