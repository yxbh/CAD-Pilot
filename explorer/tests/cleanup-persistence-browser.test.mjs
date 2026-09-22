import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { explorerRoot, workbenchRoot, workbenchPython } from "../server/paths.mjs";
import { initialState } from "../server/protocol.mjs";
import { createReference } from "../shared/references.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const viewKey = (id) => digest(`${workbenchRoot}\n${id}`).slice(0, 24);
const getModel = async (service) => (await fetch(service.url + "api/model")).json();

test("fresh cleanup measurements survive an immutable legacy cache, failed loads and provider/browser reopen", { timeout: 120_000 }, async (t) => {
  const { runtimeRoot, createService: createExplorerServer } = await createTestRuntime(t);
  const viewFile = (id) => path.join(runtimeRoot, "views", `${viewKey(id)}.json`);
  const viewId = `cleanup-persistence-${randomUUID()}`;
  const otherView = `${viewId}-other`;
  const output = path.join(explorerRoot, ".local", viewId);
  const source = path.join(output, "rounded.step");
  const browserScript = path.join(explorerRoot, "tests", "import-warnings-browser.py");
  const logs = [];
  let service, other;
  const retainedFiles = [];
  await mkdir(output, { recursive: true });
  try {
    await execute(workbenchPython, ["-B", "-c",
      "import runpy, sys; runpy.run_path(sys.argv[1])['rounded_fixture'](sys.argv[2])",
      browserScript, source,
    ], { timeout: 30_000, cwd: path.dirname(browserScript) });
    // Keep this cache independent of other tests converting the same synthetic shape.
    await writeFile(source, Buffer.concat([await readFile(source), Buffer.from(`\n/* ${viewId} */\n`)]));
    const open = (id = viewId, file) => createExplorerServer({
      projectRoot: workbenchRoot, viewId: id, file, log: (message) => logs.push(message),
    });
    const reopen = async () => {
      await service.close();
      service = await open();
      await service.initialize();
      assert.equal(service.getState().error, "");
      return getModel(service);
    };
    service = await open(viewId, source);
    await service.initialize();
    assert.equal(service.getState().error, "");
    const original = await getModel(service);
    assert.deepEqual(original.cleanup, { degenerateEdges: 10, zeroAreaTriangles: 10 });
    const measured = { topologyRevision: original.topologyRevision, counts: original.cleanup };
    const cacheFile = path.join(runtimeRoot, "models", `${original.topologyRevision}.json`);
    retainedFiles.push(cacheFile, path.join(runtimeRoot, "inputs", `${original.source.sha256}.step`));
    await service.close();
    const legacy = structuredClone(original);
    delete legacy.cleanup;
    legacy.warnings = [
      "Zero-area tessellation triangles were omitted.",
      "Degenerate CAD edge e3 was omitted from edge selection.",
    ];
    const legacyBytes = JSON.stringify(legacy);
    await writeFile(cacheFile, legacyBytes);
    const saved = JSON.parse(await readFile(viewFile(viewId), "utf8"));
    delete saved.measuredCleanup;
    await writeFile(viewFile(viewId), JSON.stringify(saved));
    const unknown = await reopen();
    assert.deepEqual(unknown.cleanup, { degenerateEdges: null, zeroAreaTriangles: null });
    assert.deepEqual(unknown.warnings, []);
    assert.equal(JSON.parse(await readFile(viewFile(viewId), "utf8")).measuredCleanup, undefined);

    const node = original.nodes.find((item) => item.partId);
    const part = original.parts.find((item) => item.id === node.partId);
    const refs = [createReference(original, node.id), createReference(original, node.id, part.faces[0].id),
      createReference(original, node.id, null, part.edges[0].id)];
    const descriptors = [];
    for (const reference of refs) {
      const descriptor = await service.execute("prepare_clipboard_reference", { reference });
      retainedFiles.push(descriptor.filePath);
      descriptors.push([descriptor.filePath, await readFile(descriptor.filePath, "utf8")]);
    }
    await service.execute("select_edge", { id: node.id, edgeId: part.edges[0].id, topologyRevision: original.topologyRevision });
    const camera = { position: [100, -100, 100], target: [0, 0, 0], up: [0, 0, 1], fov: 42 };
    const response = await fetch(service.url + "api/reviews", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: service.getState().revision, capture: {
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=",
        width: 1, height: 1, camera,
      } }),
    });
    assert.equal(response.status, 200);
    const review = await response.json();
    const reviewFile = path.join(runtimeRoot, "reviews", viewKey(viewId), `${review.id}.json`);
    const reviewBytes = await readFile(reviewFile, "utf8");
    await service.execute("close_review");

    await service.execute("load_file", { file: path.relative(workbenchRoot, source) });
    assert.deepEqual((await getModel(service)).cleanup, original.cleanup);
    assert.equal((await getModel(service)).topologyRevision, original.topologyRevision);
    assert.deepEqual(JSON.parse(await readFile(viewFile(viewId), "utf8")).measuredCleanup, measured);
    await service.execute("select_edge", { id: node.id, edgeId: part.edges[0].id, topologyRevision: original.topologyRevision });
    await service.execute("set_explode", { amount: 0.4 });
    const current = await service.execute("save_camera", {
      camera, topologyRevision: original.topologyRevision, expectedRevision: service.getState().revision,
    });
    const rendered = await fetch(service.url + "api/rendered", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: current.revision, modelHash: current.documentRevision,
        topologyRevision: current.topologyRevision, camera }),
    });
    assert.equal(rendered.status, 200);
    assert.deepEqual(JSON.parse(await readFile(viewFile(viewId), "utf8")).measuredCleanup, measured,
      "Renderer camera persistence must retain the measurement override too");

    const restored = await reopen();
    assert.deepEqual(restored.cleanup, original.cleanup);
    assert.deepEqual(restored.warnings, [], "Normalize old warning strings before overlaying counts");
    assert.deepEqual(restored.parts, original.parts);
    assert.deepEqual(restored.nodes, original.nodes);
    assert.equal(service.getState().selectedReferences[0].reference, refs[2]);
    assert.deepEqual(service.getState().camera, camera);
    assert.equal(service.getState().explode, 0.4);
    for (const reference of refs) {
      assert.equal((await service.execute("inspect_reference", { reference })).occurrence.id, node.id);
    }
    await service.execute("open_review", { id: review.id });
    assert.equal(await readFile(reviewFile, "utf8"), reviewBytes);
    await service.execute("close_review");
    const browser = await execute(workbenchPython, [
      "-B", browserScript, "--url", service.url, "--output", output, "--restored-cleanup",
    ], { timeout: 45_000, maxBuffer: 1024 * 1024 });
    t.diagnostic(browser.stdout.trim());
    assert.deepEqual((await reopen()).cleanup, original.cleanup, "Browser camera writes must preserve counts across another provider restart");

    const broken = path.join(output, "broken.step");
    await writeFile(broken, "not a STEP");
    await assert.rejects(service.execute("load_file", { file: path.relative(workbenchRoot, broken) }), { code: "conversion_failed" });
    assert.deepEqual((await getModel(service)).cleanup, original.cleanup);
    assert.deepEqual(JSON.parse(await readFile(viewFile(viewId), "utf8")).measuredCleanup, measured);
    assert.deepEqual((await reopen()).cleanup, original.cleanup, "Failed imports must not replace known counts");
    await service.close();
    service = await open(viewId, broken);
    await service.initialize();
    assert.match(service.getState().error, /STEP conversion failed/);
    assert.equal(JSON.parse(await readFile(viewFile(viewId), "utf8")).modelCache, path.basename(cacheFile));
    assert.deepEqual((await reopen()).cleanup, original.cleanup, "A failed explicit startup import must preserve the saved snapshot and counts");
    assert.equal(await readFile(cacheFile, "utf8"), legacyBytes);
    assert.equal(digest(await readFile(cacheFile)), digest(legacyBytes));
    for (const [file, bytes] of descriptors) assert.equal(await readFile(file, "utf8"), bytes);
    assert.equal(await readFile(reviewFile, "utf8"), reviewBytes);
    assert.ok(!logs.some((message) => /Rebuilding/.test(message)));

    await writeFile(viewFile(otherView), JSON.stringify({
      state: { ...initialState(), topologyRevision: original.topologyRevision, documentRevision: original.source.sha256 },
      modelCache: path.basename(cacheFile), inputFile: saved.inputFile, inputName: saved.inputName,
    }));
    other = await open(otherView);
    await other.initialize();
    assert.deepEqual((await getModel(other)).cleanup, unknown.cleanup, "An unrelated view has no newly measured counts");
    await other.close();

    await service.execute("load_demo");
    const different = await getModel(service);
    assert.notEqual(different.topologyRevision, original.topologyRevision);
    assert.deepEqual(different.cleanup, { degenerateEdges: 0, zeroAreaTriangles: 0 });
    assert.deepEqual(JSON.parse(await readFile(viewFile(viewId), "utf8")).measuredCleanup,
      { topologyRevision: different.topologyRevision, counts: different.cleanup });
    assert.deepEqual((await reopen()).cleanup, different.cleanup);
    await service.close();
    const stale = JSON.parse(await readFile(viewFile(viewId), "utf8"));
    stale.measuredCleanup = measured;
    await writeFile(viewFile(viewId), JSON.stringify(stale));
    assert.deepEqual((await reopen()).cleanup, different.cleanup, "A prior topology's counts cannot override the verified current cache");
    assert.ok(logs.includes("Discarding saved cleanup counts for a different topology revision."));
    assert.equal(JSON.parse(await readFile(viewFile(viewId), "utf8")).measuredCleanup, undefined);
    await service.close();
    const validSaved = JSON.parse(await readFile(viewFile(viewId), "utf8"));
    for (const invalid of [null, { ...measured, topologyRevision: "bad" },
      { ...measured, counts: { degenerateEdges: null, zeroAreaTriangles: null } },
      { ...measured, counts: { degenerateEdges: 200_001, zeroAreaTriangles: 30 } },
      { ...measured, extra: true }]) {
      const bytes = JSON.stringify({ ...validSaved, measuredCleanup: invalid });
      await writeFile(viewFile(viewId), bytes);
      await assert.rejects(open(), { code: "invalid_saved_cleanup" });
      assert.equal(await readFile(viewFile(viewId), "utf8"), bytes, "Malformed saved metadata must not overwrite the existing view");
    }
    t.diagnostic(`Restored cleanup browser evidence: ${output}`);
  } finally {
    await service?.close();
    await other?.close();
    await Promise.all([...retainedFiles, viewFile(viewId), viewFile(otherView)].map((file) => rm(file, { force: true })));
    await rm(path.join(runtimeRoot, "reviews", viewKey(viewId)), { recursive: true, force: true });
  }
});
