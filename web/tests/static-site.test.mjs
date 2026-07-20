import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("собирается как статическая PWA без серверного бандла", async () => {
  const [html, manifest, files] = await Promise.all([
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/manifest.webmanifest", import.meta.url), "utf8"),
    readdir(new URL("../dist/", import.meta.url)),
  ]);

  assert.match(html, /p2p-netcat web/);
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /%BASE_URL%/);
  assert.ok(files.includes("sw.js"));
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.display, "standalone");
  assert.equal(parsedManifest.start_url, parsedManifest.scope);
  assert.ok(parsedManifest.icons.every((icon) => icon.src.startsWith(parsedManifest.scope)));
  await assert.rejects(access(new URL("../dist/server/", import.meta.url)));
});

test("сетевой стек работает в отдельном Web Worker", async () => {
  const [worker, client, core] = await Promise.all([
    readFile(new URL("../app/p2p.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/p2p-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/core/src/index.js", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /@santaklouse\/p2p-netcat-core/);
  assert.doesNotMatch(worker, /const PROTOCOL_PREFIX/);
  assert.match(core, /\/p2p-netcat\/1\.0\.0/);
  assert.match(worker, /circuitRelayTransport\(\)/);
  assert.match(worker, /webSockets\(\)/);
  assert.match(client, /new Worker\(new URL/);
  assert.match(client, /transfer/);
});
