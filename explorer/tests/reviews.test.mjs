import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { ReviewStore, pngBytes } from "../server/reviews.mjs";
import { emptyDrawing } from "../shared/drawing.mjs";
import { initialState } from "../server/protocol.mjs";

const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=";
const camera = { position: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 42 };
const state = { ...initialState(), revision: 5, modelName: "Review model.step", documentRevision: "a".repeat(64), topologyRevision: "b".repeat(64), explode: 0.5 };
const capture = { dataUrl, width: 1, height: 1, camera };
const stroke = { id: "pen-1", tool: "pen", color: "#ff0000", width: 3, points: [[0.1, 0.2], [0.8, 0.7]] };
async function testDirectory() {
  const directory = path.resolve(import.meta.dirname, "..", ".local", `review-store-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

test("reviews persist drawing history and remain bound to their original image and geometry revision", async () => {
  const directory = await testDirectory();
  try {
    const store = new ReviewStore(directory);
    const original = await store.create(capture, state, 5);
    assert.equal(original.pose.explode, 0.5);
    assert.equal(original.source.topologyRevision, state.topologyRevision);
    const drawing = { past: [[]], present: [stroke], future: [] };
    const saved = await store.save(original.id, drawing, 1);
    assert.equal(saved.version, 2);
    assert.equal(saved.image.dataUrl, dataUrl);
    assert.equal(saved.pose.camera.fov, 42);
    assert.equal((await new ReviewStore(directory).get(original.id)).drawing.present[0].id, stroke.id);
    const result = await store.saveImage(original.id, 2, dataUrl);
    const metadata = JSON.parse(await readFile(`${result.path}.json`, "utf8"));
    assert.deepEqual(metadata.drawing, [stroke]);
    assert.equal(metadata.pose.explode, 0.5);
    assert.equal((await store.list())[0].strokeCount, 1);
    await assert.rejects(store.save(original.id, emptyDrawing(), 1), /changed in another panel/);
    await assert.rejects(store.saveImage(original.id, 1, dataUrl), /Review changed/);
    await assert.rejects(store.create(capture, state, 4), /View changed/);
    await assert.rejects(store.create(capture, { ...state, activeReviewId: original.id }, 5), /Return to the model/);
    await assert.rejects(store.create({ ...capture, width: 2 }, state, 5), /size does not match/);
    await assert.rejects(store.get("../escape"), /Invalid review ID/);
    await assert.rejects(store.save(original.id, { present: [{ ...stroke, points: [[-10, 0]] }], past: [], future: [] }, 2));
    assert.deepEqual((await store.get(original.id)).drawing, drawing);
  } finally { await rm(directory, { recursive: true }); }
});

test("review image limits reject oversized headers before allocation", () => {
  const { bytes } = pngBytes(dataUrl);
  const huge = Buffer.from(bytes);
  huge.writeUInt32BE(50000, 16);
  assert.throws(() => pngBytes(`data:image/png;base64,${huge.toString("base64")}`), /dimensions/);
  assert.throws(() => pngBytes("data:text/html;base64,PGgxPmZha2U8L2gxPg=="), /Expected a PNG/);
});

test("reviews retain Studio and orthographic metadata while pre-projection reviews still reopen", async () => {
  const directory = await testDirectory();
  try {
    const store = new ReviewStore(directory);
    const studio = { ...state, projection: "orthographic", appearance: "studio", materialFinish: "satin", showEdges: false };
    const image = { ...capture, camera: { ...camera, projection: "orthographic", viewHeight: 92.5 } };
    const review = await store.create(image, studio, studio.revision);
    const restored = await new ReviewStore(directory).get(review.id);
    assert.equal(restored.pose.camera.viewHeight, 92.5);
    assert.equal(restored.pose.appearance, "studio");
    assert.equal(restored.pose.materialFinish, "satin");
    assert.equal(restored.pose.showEdges, false);
    await assert.rejects(store.create(capture, studio, studio.revision), /projection/);
    const legacy = await store.create(capture, state, state.revision);
    delete legacy.pose.appearance;
    delete legacy.pose.materialFinish;
    delete legacy.pose.showEdges;
    await writeFile(store.file(legacy.id), JSON.stringify(legacy));
    assert.deepEqual((await store.get(legacy.id)).pose.camera, camera);
  } finally { await rm(directory, { recursive: true }); }
});

test("recovery copy preserves the immutable capture and leaves concurrent server marks untouched", async () => {
  const directory = await testDirectory();
  try {
    const first = new ReviewStore(directory);
    const second = new ReviewStore(directory);
    const original = await first.create(capture, state, state.revision);
    const remoteDrawing = { past: [[]], present: [{ ...stroke, id: "remote-mark" }], future: [] };
    const localDrawing = { past: [[]], present: [{ ...stroke, id: "local-mark" }], future: [] };
    const remote = await second.save(original.id, remoteDrawing, original.version);
    await assert.rejects(first.save(original.id, localDrawing, original.version), { code: "stale_review" });
    const before = await readFile(first.file(original.id), "utf8");
    const copy = await first.copy(original.id, localDrawing);
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.version, 1);
    assert.deepEqual(copy.drawing, localDrawing);
    for (const field of ["image", "source", "pose"]) assert.deepEqual(copy[field], original[field]);
    assert.equal(await readFile(first.file(original.id), "utf8"), before);
    assert.deepEqual((await first.get(original.id)).drawing, remote.drawing);
    assert.deepEqual((await new ReviewStore(directory).get(copy.id)).drawing, localDrawing);
    await assert.rejects(first.copy(original.id, { ...localDrawing, present: [{ ...stroke, width: 99 }] }), { code: "invalid_drawing" });
    assert.equal((await first.list()).length, 2);
  } finally { await rm(directory, { recursive: true }); }
});

test("summary lists scan once and only reparse changed reviews, including writes by another store", async () => {
  const directory = await testDirectory();
  try {
    const writer = new ReviewStore(directory);
    const originals = [];
    for (let index = 0; index < 12; index++) originals.push(await writer.create(capture, state, state.revision));
    const reader = new ReviewStore(directory);
    let reads = 0;
    const get = reader.get.bind(reader);
    reader.get = async (...args) => { reads++; return get(...args); };
    const [list] = await Promise.all([reader.list(), reader.list(), reader.list()]);
    assert.equal(list.length, 12);
    assert.equal(reads, 12, "Concurrent initial lists share one validated scan");
    list[0].title = "Mutated by caller";
    reads = 0;
    for (let index = 0; index < 6; index++) await reader.list();
    assert.equal(reads, 0, "Repeated lists must not parse embedded PNGs");
    assert.notEqual((await reader.list())[0].title, "Mutated by caller");
    let version = originals[0].version;
    for (let index = 0; index < 5; index++) {
      await reader.save(originals[0].id, { past: [], present: [{ ...stroke, id: `stroke-${index}` }], future: [] }, version++);
      assert.equal((await reader.list()).find((item) => item.id === originals[0].id).version, version);
    }
    assert.equal(reads, 10, "Each stroke reads only its own review, plus one invalidated summary");
    await writer.save(originals[1].id, { past: [], present: [stroke], future: [] }, 1);
    const updated = await reader.list();
    assert.equal(reads, 11, "An external write reparses only its changed review");
    assert.equal(updated.find((item) => item.id === originals[1].id).strokeCount, 1);
    const corrupted = { ...originals[2], drawing: { past: [], present: [{ ...stroke, width: 100 }], future: [] } };
    await writeFile(writer.file(corrupted.id), JSON.stringify(corrupted));
    await assert.rejects(reader.list(), /width/);
    await writeFile(writer.file(originals[2].id), JSON.stringify(originals[2]));
    await reader.list();
    assert.ok(reader.summaries.size <= 20);
  } finally { await rm(directory, { recursive: true }); }
});

test("separate recovery copies obey the existing review capacity without altering originals", async () => {
  const directory = await testDirectory();
  try {
    const store = new ReviewStore(directory);
    const original = await store.create(capture, state, state.revision);
    for (let index = 1; index < 20; index++) await store.copy(original.id, emptyDrawing());
    await assert.rejects(store.copy(original.id, emptyDrawing()), { code: "review_limit" });
    assert.equal((await store.get(original.id)).version, 1);
    assert.equal((await store.list()).length, 20);
    assert.ok(store.summaries.size <= 20);
  } finally { await rm(directory, { recursive: true }); }
});
