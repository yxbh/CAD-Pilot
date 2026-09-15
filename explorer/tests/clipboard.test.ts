import assert from "node:assert/strict";
import test from "node:test";
import { copyFromGesture, copyPreparedReference, createClipboardWriter } from "../src/clipboard.ts";

test("clipboard writing begins inside the caller's gesture, without waiting for selection HTTP", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const pending = copyFromGesture("face-reference", {
    writeText: (text) => { calls.push(text); return new Promise<void>((resolve) => { finish = resolve; }); },
    legacyCopy: () => { throw new Error("Unexpected fallback"); },
  });
  assert.deepEqual(calls, ["face-reference"]);
  finish();
  assert.deepEqual(await pending, { ok: true, method: "clipboard" });
});

test("clipboard denial uses a real selection-copy fallback, never a success-shaped default", async () => {
  const copied: string[] = [];
  const result = await copyFromGesture("face-reference", {
    writeText: () => Promise.reject(new Error("denied")),
    legacyCopy: (text) => { copied.push(text); return true; },
  });
  assert.deepEqual(result, { ok: true, method: "selection" });
  assert.deepEqual(copied, ["face-reference"]);
  const denied = await copyFromGesture("face-reference", { writeText: undefined, legacyCopy: () => false });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error, /Ctrl\+C/);
});

test("denial switches later clicks to synchronous fallback; explicit Copy retries modern access", async () => {
  let attempts = 0;
  const fallback: string[] = [];
  const write = createClipboardWriter({
    writeText: () => { attempts++; return Promise.reject(new Error("iframe denied")); },
    legacyCopy: (text) => { fallback.push(text); return true; },
  });
  assert.equal((await write("first")).ok, true);
  const second = write("second");
  assert.deepEqual(fallback, ["first", "second"]);
  assert.equal(attempts, 1);
  await second;
  await write("retry", true);
  assert.equal(attempts, 2);
});

test("native clipboard write starts synchronously but waits until the reference file is ready", async () => {
    let prepare!: (value: { text: string; title: string }) => void;
    const pending = new Promise<{ text: string; title: string }>((resolve) => { prepare = resolve; });
    let invoked = false;
    let contents = "";
    const copied = copyPreparedReference(pending, () => { throw new Error("Unexpected fallback"); }, (data) => {
      invoked = true;
      return data.then(async (blob) => { contents = await blob.text(); });
    });
    assert.equal(invoked, true);
    assert.equal(contents, "");
    prepare({ text: '<copilot-ref kind="file" target-id="face.json" label="Face f6" />', title: "Face f6" });
    const result = await copied;
    assert.equal(result.result.ok, true);
    assert.equal(contents, result.prepared.text);
});

test("failed reference preparation never copies an unresolved file reference", async () => {
    let fallbackCalls = 0;
    let written = false;
    await assert.rejects(copyPreparedReference(Promise.reject(new Error("disk full")), async () => {
      fallbackCalls++;
      return { ok: true, method: "selection" };
    }, (data) => data.then(() => { written = true; })), /disk full/);
    assert.equal(written, false);
    assert.equal(fallbackCalls, 0);
});
