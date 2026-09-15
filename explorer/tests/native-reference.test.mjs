import assert from "node:assert/strict";
import test from "node:test";
import { nativeFileReference, nativeReferenceTitle } from "../shared/native-reference.mjs";

test("clipboard markup uses the host's native file-reference kind and escapes attributes", () => {
  const markup = nativeFileReference('D:\\model & data\\face.json', 'Cover "front" <face>');
  assert.equal(markup, '<copilot-ref kind="file" target-id="D:\\model &amp; data\\face.json" label="Cover &quot;front&quot; &lt;face&gt;" />');
  assert.throws(() => nativeFileReference("a\nb", "Face"), /path/);
  assert.throws(() => nativeFileReference("", "Face"), /path/);
  assert.throws(() => nativeFileReference("a.json", ""), /label/);
});

test("native file-chip labels retain the occurrence name and face after basename formatting", () => {
  for (const [part, face, expected] of [
    ["Cover plate", "f6", "Cover plate \u00b7 Face f6"],
    ["Spacer 1", "f1", "Spacer 1 \u00b7 Face f1"],
    ["Spacer 2", "f1", "Spacer 2 \u00b7 Face f1"],
    ["Module/Cover\\left", "f6", "Module \u00b7 Cover \u00b7 left \u00b7 Face f6"],
    ["Base plate", null, "Base plate \u00b7 Part"],
  ]) {
    const label = nativeReferenceTitle(part, face);
    assert.equal(label, expected);
    assert.equal(label.replaceAll("\\", "/").split("/").at(-1), expected);
    assert.ok(nativeFileReference("face.json", label).includes(`label="${expected}"`));
  }
});

test("long part labels preserve both the name prefix and the face suffix", () => {
  const label = nativeReferenceTitle("Cover " + "a".repeat(220), "f123");
  assert.equal(label.length, 160);
  assert.ok(label.startsWith("Cover "));
  assert.ok(label.endsWith("... \u00b7 Face f123"));
  assert.throws(() => nativeReferenceTitle("", "f1"), /part name/);
  assert.throws(() => nativeReferenceTitle("Part", "face"), /face label/);
});
