import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { assertBuilt } from "../server/launcher.mjs";
import { workbenchRoot } from "../server/paths.mjs";
import { createHeadlessRenderer } from "../server/renderer.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

test("a background page that cannot create WebGL is restarted in software and still captures", { timeout: 120_000 }, async (t) => {
  await assertBuilt();
  // The first browser has no WebGL at all, so three.js fails inside react-three-fiber's asynchronous setup.
  const software = [];
  const renderer = (options) => createHeadlessRenderer({
    ...options,
    launch: (executable, args, spawnOptions) => {
      software.push(args.includes("--use-angle=swiftshader"));
      return spawn(executable, software.at(-1) ? args : [...args.slice(0, -1), "--disable-webgl", args.at(-1)], spawnOptions);
    },
  });
  const runtime = await createTestRuntime(t);
  const service = await runtime.createService({ projectRoot: workbenchRoot, viewId: `no-webgl-${Date.now()}`, renderer });
  await service.initialize();
  const captured = await service.captureImage({ width: 64, height: 48 });
  assert.deepEqual([captured.width, captured.height], [64, 48]);
  assert.deepEqual(software, [false, true]);
});
