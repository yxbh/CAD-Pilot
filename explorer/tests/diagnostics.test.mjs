import assert from "node:assert/strict";
import test from "node:test";
import { importWarnings } from "../shared/diagnostics.mjs";

test("legacy generic limitations are not reported as model-specific import warnings", () => {
  const messages = [
    "Prototype preview: part-level RGB only; PMI, layers, materials, textures and saved views are not represented.",
    "STEP transfer: actual file warning",
    "Transparency is unsupported; transparent parts are shown opaque.",
    "Zero-area tessellation triangles were omitted.",
  ];
  assert.deepEqual(importWarnings(messages), messages.slice(1));
  assert.equal(messages.length, 4);
});
