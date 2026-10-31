import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneIfDue, pruneRuntime, RETENTION } from "../server/runtime-store.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

const day = 24 * 60 * 60 * 1000;
const hex = (character) => character.repeat(64);

async function store(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cad-explorer-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ["inputs", "models", "captures", "references", "views"]) await mkdir(path.join(root, folder));
  const now = Date.now();
  const put = async (relative, ageDays, bytes = 10) => {
    const file = path.join(root, relative);
    await writeFile(file, Buffer.alloc(bytes));
    const time = new Date(now - ageDays * day);
    await utimes(file, time, time);
  };
  return { root, now, put, list: async (folder) => (await readdir(path.join(root, folder))).sort() };
}

test("pruning keeps what saved setups show and recent work, and removes old unused snapshots, captures and orphans", async (t) => {
  const { root, now, put, list } = await store(t);
  // A setup used today protects its snapshot and model however old they are.
  await writeFile(path.join(root, "views", "a".repeat(24) + ".json"), JSON.stringify({ modelCache: `${hex("1")}.json`, inputFile: path.join(root, "inputs", `${hex("1")}.step`) }));
  await put(`inputs/${hex("1")}.step`, 60);
  await put(`models/${hex("1")}.json`, 60);
  // A setup unused for longer than RETENTION.setupDays no longer protects what it showed.
  await writeFile(path.join(root, "views", "b".repeat(24) + ".json"), JSON.stringify({ modelCache: `${hex("8")}.json` }));
  await utimes(path.join(root, "views", "b".repeat(24) + ".json"), new Date(now - 40 * day), new Date(now - 40 * day));
  await put(`models/${hex("8")}.json`, 40);
  await put(`inputs/${hex("2")}.step`, 30);
  await put(`models/${hex("2")}.json`, 30);
  await put(`models/${hex("3")}.json`, 2);
  assert.ok(2 < RETENTION.keepDays && RETENTION.keepDays < 30);
  await put(`models/${hex("4")}.json`, 0.001, 5);
  await mkdir(path.join(root, "models", ".import-old"));
  const staleTime = new Date(now - day);
  await utimes(path.join(root, "models", ".import-old"), staleTime, staleTime);
  for (let index = 0; index < RETENTION.keepCaptures + 3; index++) await put(`captures/${String(index).padStart(3, "0")}.png`, 1 + index / 1000);
  await put("captures/old.png", 30);
  await put("captures/old.png.json", 30);
  await writeFile(path.join(root, "references", "kept.json"), JSON.stringify({ topologyRevision: hex("3") }));
  await writeFile(path.join(root, "references", "orphan.json"), JSON.stringify({ topologyRevision: hex("2") }));
  await utimes(path.join(root, "references", "orphan.json"), staleTime, staleTime);

  const planned = await pruneRuntime(root, { dryRun: true, now });
  assert.equal((await list("models")).length, 6, "a dry run removes nothing");
  const result = await pruneRuntime(root, { now });
  assert.deepEqual(planned.removed, result.removed);
  assert.deepEqual(result.removed, { inputs: 1, models: 2, captures: 4, references: 1, staging: 1 });
  assert.deepEqual(await list("inputs"), [`${hex("1")}.step`]);
  assert.deepEqual(await list("models"), [`${hex("1")}.json`, `${hex("3")}.json`, `${hex("4")}.json`]);
  assert.equal((await list("captures")).length, RETENTION.keepCaptures);
  assert.ok(!(await list("captures")).includes("old.png.json"), "a capture's metadata goes with it");
  assert.deepEqual(await list("references"), ["kept.json"]);

  // --all keeps only what a setup shows, plus anything just written.
  const all = await pruneRuntime(root, { all: true, now });
  assert.deepEqual(await list("models"), [`${hex("1")}.json`, `${hex("4")}.json`]);
  assert.equal(all.removed.captures, RETENTION.keepCaptures);
});

test("the snapshot budget removes the oldest unused snapshots first", async (t) => {
  const { root, now, put, list } = await store(t);
  await put(`models/${hex("5")}.json`, 3, 600);
  await put(`models/${hex("6")}.json`, 2, 600);
  await put(`models/${hex("7")}.json`, 1, 600);
  const result = await pruneRuntime(root, { now, retention: { ...RETENTION, maxSnapshotBytes: 1300 } });
  assert.equal(result.removed.models, 1);
  assert.deepEqual(await list("models"), [`${hex("6")}.json`, `${hex("7")}.json`]);
});

test("viewers and one-shot renders in separate processes space their prunes out through the store", async (t) => {
  const { root, now, put, list } = await store(t);
  await put(`models/${hex("9")}.json`, 30);
  const first = await pruneIfDue(root, { now });
  assert.equal(first.removed.models, 1);
  await put(`models/${hex("a")}.json`, 30);
  assert.equal(await pruneIfDue(root, { now: now + 60_000 }), null, "a prune within the interval is skipped");
  assert.deepEqual(await list("models"), [`${hex("a")}.json`]);
  assert.equal((await pruneIfDue(root, { now: Date.now() + 11 * 60_000 })).removed.models, 1);
});

test("a model cache's companion files share its fate, and snapshots of any format are kept by the setup that shows them", async (t) => {
  const { root, now, put, list } = await store(t);
  // A setup showing several files names each of them somewhere in its saved view.
  await writeFile(path.join(root, "views", "c".repeat(24) + ".json"), JSON.stringify({
    modelCache: `${hex("b")}.json`, references: [{ modelCache: `${hex("c")}.json`, inputFile: `/x/${hex("c")}.stl` }],
  }));
  for (const name of [`${hex("b")}.json`, `${hex("c")}.json`, `${hex("c")}.bin`, `${hex("d")}.json`, `${hex("d")}.bin`]) await put(`models/${name}`, 30);
  await put(`inputs/${hex("c")}.stl`, 30);
  await put(`inputs/${hex("d")}.3mf`, 30);
  const result = await pruneRuntime(root, { now });
  assert.deepEqual([result.removed.models, result.removed.inputs], [1, 1]);
  assert.deepEqual(await list("models"), [`${hex("b")}.json`, `${hex("c")}.bin`, `${hex("c")}.json`]);
  assert.deepEqual(await list("inputs"), [`${hex("c")}.stl`]);
});

test("geometry left without its model cache is removed once it is no longer recent", async (t) => {
  const { root, now, put, list } = await store(t);
  await put(`models/${hex("e")}.bin`, 30);
  // A mesh publishes its geometry before its manifest, so a new lone geometry file may be a publish in progress.
  await put(`models/${hex("f")}.bin`, 0.001);
  const result = await pruneRuntime(root, { now });
  assert.equal(result.removed.models, 1);
  assert.deepEqual(await list("models"), [`${hex("f")}.bin`]);
});

test("a one-shot render's private folder left by an interrupted render is removed with other staging", async (t) => {
  // A one-shot render keeps its image inside the store, where cleanup can find it, rather than in the system's temp folder.
  const runtime = await createTestRuntime(t);
  const render = await runtime.createService({ projectRoot: runtime.runtimeRoot, viewId: "render-once", transient: true, log: () => {} });
  const folders = await readdir(path.join(runtime.runtimeRoot, "captures"));
  assert.equal(folders.length, 1);
  assert.match(folders[0], /^\.render-/);
  await render.close();
  assert.deepEqual(await readdir(path.join(runtime.runtimeRoot, "captures")), [], "a render that finishes removes its own folder");

  const { root, now, list } = await store(t);
  for (const [name, ageDays] of [[".render-old", 1], [".render-new", 0.001]]) {
    await mkdir(path.join(root, "captures", name));
    await writeFile(path.join(root, "captures", name, "image.png"), "");
    const time = new Date(now - ageDays * day);
    await utimes(path.join(root, "captures", name), time, time);
  }
  const result = await pruneRuntime(root, { now });
  assert.equal(result.removed.staging, 1);
  assert.deepEqual(await list("captures"), [".render-new"]);
});

test("a snapshot reused while a prune runs is kept, though the prune listed it as old", async (t) => {
  const { root, now, put, list } = await store(t);
  // Many old snapshots ahead of the reused one, which is the oldest and so removed last.
  const others = Array.from({ length: 3000 }, (_, index) => `${index.toString(16).padStart(64, "0")}.step`);
  for (const name of others) await put(`inputs/${name}`, 20, 0);
  await put(`inputs/${hex("9")}.step`, 40);
  const pruning = pruneRuntime(root, { now });
  // Once the first file is gone the prune has listed everything; another process then reopens the old snapshot.
  while ((await readdir(path.join(root, "inputs"))).length > others.length) await new Promise((resolve) => setImmediate(resolve));
  await utimes(path.join(root, "inputs", `${hex("9")}.step`), new Date(), new Date());
  const result = await pruning;
  assert.ok(result.removed.inputs >= 1, "the prune had started removing");
  assert.ok((await list("inputs")).includes(`${hex("9")}.step`), "the reused snapshot was removed");
});
