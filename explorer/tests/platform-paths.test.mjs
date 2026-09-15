import assert from "node:assert/strict";
import test from "node:test";
import { workbenchPythonPath } from "../server/paths.mjs";
import { viewOwnerAddress } from "../server/view-owner.mjs";

test("workbench Python paths follow Windows and POSIX virtualenv layouts", () => {
  assert.equal(
    workbenchPythonPath("C:\\work\\CAD-Pilot", "win32"),
    "C:\\work\\CAD-Pilot\\.venv\\Scripts\\python.exe",
  );
  assert.equal(
    workbenchPythonPath("/work/CAD-Pilot", "darwin"),
    "/work/CAD-Pilot/.venv/bin/python",
  );
});

test("view ownership retains Windows pipes and bounds Unix socket paths", () => {
  const key = "a".repeat(64);
  const name = `cad-pilot-view-${key}.sock`;
  assert.equal(viewOwnerAddress(key, "win32"), `\\\\.\\pipe\\cad-pilot-view-${key}`);
  assert.equal(viewOwnerAddress(key, "darwin", "/tmp"), `/tmp/${name}`);
  assert.equal(
    viewOwnerAddress(key, "darwin", `/private/${"long-temporary-directory/".repeat(6)}`),
    `/tmp/${name}`,
  );
});
