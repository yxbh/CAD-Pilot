import assert from "node:assert/strict";
import test from "node:test";
import { replaceFile } from "../server/storage.mjs";

test("atomic replacement retries transient Windows read locks without deleting the target", async () => {
  let attempts = 0;
  const pauses = [];
  await replaceFile("temporary", "original", {
    rename: async (from, to) => {
      assert.equal(from, "temporary"); assert.equal(to, "original");
      if (++attempts < 3) throw Object.assign(new Error("Locked"), { code: "EPERM" });
    },
    delay: async (ms) => { pauses.push(ms); },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(pauses, [25, 50]);
});
test("persistent failures remain explicit and bounded", async () => {
  let attempts = 0;
  await assert.rejects(replaceFile("tmp", "target", {
    rename: async () => { attempts++; throw Object.assign(new Error("Denied"), { code: "EACCES" }); },
    delay: async () => {},
  }), /Denied/);
  assert.equal(attempts, 8);
  attempts = 0;
  await assert.rejects(replaceFile("tmp", "target", {
    rename: async () => { attempts++; throw Object.assign(new Error("Full"), { code: "ENOSPC" }); },
    delay: async () => {},
  }), /Full/);
  assert.equal(attempts, 1);
});
