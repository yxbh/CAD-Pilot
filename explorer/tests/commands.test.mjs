import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, commandDefinition } from "../shared/commands.mjs";
import { initialState, validateCommandRevision } from "../server/protocol.mjs";

test("command revision, render and review policies remain explicit", () => {
  const matching = (field, value) => Object.keys(COMMANDS).filter((name) => COMMANDS[name][field] === value).sort();
  assert.deepEqual(matching("revision", "required"), ["add_reference_to_chat", "save_camera"]);
  assert.deepEqual(matching("revision", "unchecked"), [
    "capture_image", "get_review", "get_state", "inspect_reference", "list_reviews", "load_demo", "load_file", "prepare_clipboard_reference",
  ]);
  assert.deepEqual(matching("render", "none"), [
    "add_reference_to_chat", "close_review", "get_review", "get_state", "inspect_reference", "list_reviews",
    "open_review", "prepare_clipboard_reference", "save_camera", "set_auto_copy",
  ]);
  assert.deepEqual(matching("duringReview", true), [
    "add_reference_to_chat", "capture_image", "close_review", "get_review", "get_state", "inspect_reference",
    "list_reviews", "open_review", "prepare_clipboard_reference", "set_auto_copy",
  ]);
  assert.deepEqual(matching("render", "capture"), ["capture_image"]);
  assert.deepEqual(matching("canvas", false), ["save_camera"]);
});

test("every command enforces its declared revision policy", () => {
  const state = { ...initialState(), revision: 7 };
  for (const [name, definition] of Object.entries(COMMANDS)) {
    assert.doesNotThrow(() => validateCommandRevision(state, name, 7));
    for (const revision of [undefined, 6]) {
      const rejects = definition.revision === "required" || (definition.revision === "optional" && revision !== undefined);
      if (rejects) assert.throws(() => validateCommandRevision(state, name, revision), { code: "stale_view" }, name);
      else assert.doesNotThrow(() => validateCommandRevision(state, name, revision), name);
    }
  }
  for (const name of ["missing", "toString", "__proto__"]) {
    assert.equal(commandDefinition(name), undefined);
    assert.throws(() => validateCommandRevision(state, name, 7), { code: "unknown_command" });
  }
});
