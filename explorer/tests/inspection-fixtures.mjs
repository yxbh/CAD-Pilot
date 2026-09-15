import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInspectionService } from "../server/inspection.mjs";
import { topologyRevision } from "../server/protocol.mjs";
import { createReference } from "../shared/references.mjs";

const workbenchRoot = fileURLToPath(new URL("../..", import.meta.url));

export function inspectionModel(sha256, triangles = 2) {
  const bounds = { min: [0, 0, 0], max: [1.125, 1.5, 0] };
  const positions = [0, 0, 0, 1.125, 0, 0, 1.125, 1.5, 0];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const model = {
    schemaVersion: 2, source: { name: "synthetic-inspection.step", sha256 }, units: "mm", warnings: [], bounds,
    parts: [{
      id: "shape", label: "Synthetic plate", color: [1, 0, 0], bounds,
      positions: Array.from({ length: triangles * 9 }, (_, i) => positions[i % 9]),
      normals: Array.from({ length: triangles * 9 }, (_, i) => normals[i % 9]),
      indices: Array.from({ length: triangles * 3 }, (_, i) => i),
      faces: [{ id: "f1", triangleStart: 0, triangleCount: triangles, area: 1.6875, center: [0.5625, 0.75, 0], surfaceType: "plane", bounds }],
    }],
    nodes: ["node:root/a", "node:root/b"].map((id, i) => ({
      id, label: `Synthetic occurrence ${i}`, parentId: null, partId: "shape", color: [1, 0, 0],
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 10, 0, 0, 1],
    })),
  };
  model.topologyRevision = topologyRevision(model);
  return model;
}

export async function inspectionFixture(t, { triangles = 2, sourceBytes = 512, cacheLimits, io } = {}) {
  const runtimeRoot = path.join(workbenchRoot, ".local", "inspection-tests", randomUUID());
  await mkdir(path.join(runtimeRoot, "inputs"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "models"), { recursive: true });
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const block = Buffer.alloc(Math.min(sourceBytes, 64 * 1024), "Synthetic inspection bytes; not an actual STEP assembly.\n");
  const digest = createHash("sha256");
  for (let offset = 0; offset < sourceBytes; offset += block.length) digest.update(block.subarray(0, Math.min(block.length, sourceBytes - offset)));
  const sha256 = digest.digest("hex");
  const sourceFile = path.join(runtimeRoot, "inputs", `${sha256}.step`);
  const handle = await open(sourceFile, "w");
  try {
    for (let offset = 0; offset < sourceBytes; offset += block.length) await handle.write(block.subarray(0, Math.min(block.length, sourceBytes - offset)));
  } finally { await handle.close(); }
  const model = inspectionModel(sha256, triangles);
  const modelFile = path.join(runtimeRoot, "models", `${model.topologyRevision}.json`);
  await writeFile(modelFile, JSON.stringify(model));
  const service = createInspectionService({ runtimeRoot, workbenchRoot, cacheLimits, io });
  return { model, modelFile, sourceFile, runtimeRoot, workbenchRoot, service, reference: createReference(model, model.nodes[0].id, "f1") };
}

export function latch() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export function inspectionIo({ afterModelRead, afterSourceRead } = {}) {
  return {
    stat,
    async open(file, flags) {
      const handle = await open(file, flags);
      return {
        stat: (...args) => handle.stat(...args),
        close: () => handle.close(),
        async readFile(...args) {
          const result = await handle.readFile(...args);
          await afterModelRead?.(file);
          return result;
        },
        async *createReadStream(options) {
          yield* handle.createReadStream(options);
          await afterSourceRead?.(file);
        },
      };
    },
  };
}
