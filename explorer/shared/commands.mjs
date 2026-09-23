import { MATERIAL_FINISHES, PROJECTIONS, VIEW_PRESETS } from "./view-settings.mjs";
import { SECTION_AXES } from "./section.mjs";

export const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const ids = { type: "array", items: { type: "string" }, maxItems: 500 };
const revision = { type: "integer", minimum: 0 };
const reference = { type: "string", maxLength: 16384 };

function command(description, properties = {}, required = [], policy = {}) {
  return {
    description,
    inputSchema: objectSchema({ ...properties, expectedRevision: revision }, required),
    revision: "optional", render: "live", duringReview: false, canvas: true,
    ...policy,
  };
}
const read = (description, properties, required) => command(description, properties, required, {
  revision: "unchecked", render: "none", duringReview: true,
});

// Schemas describe canvas inputs; contextual geometry and state validation stays on the server.
export const COMMANDS = Object.freeze({
  get_state: read("Read the model, camera, selections, saved setup and actual renderer acknowledgement."),
  set_explode: command("Separate parts visually without moving the camera or changing the STEP. Fit assembly separately if needed.", {
    amount: { type: "number", minimum: 0, maximum: 1 },
    fixedId: { type: "string", description: "Occurrence to keep fixed, or empty to clear." },
    direction: { enum: ["radial", "x", "y", "z"] },
  }),
  select_parts: command("Highlight occurrences without writing the clipboard.", { ids }, ["ids"]),
  select_face: command("Highlight a CAD face on the exact displayed topology, without writing the clipboard.", {
    id: { type: "string" }, faceId: { type: "string" }, topologyRevision: { type: "string" },
  }, ["id", "faceId", "topologyRevision"]),
  select_edge: command("Highlight a native CAD edge on the exact displayed topology, without writing the clipboard.", {
    id: { type: "string" }, edgeId: { type: "string" }, topologyRevision: { type: "string" },
  }, ["id", "edgeId", "topologyRevision"]),
  set_selection_mode: command("Choose face, edge or whole-part picking.", { mode: { enum: ["face", "edge", "part"] } }, ["mode"]),
  set_auto_copy: command("Enable clipboard copying for future user selections. Selection never inserts or sends a chat message.",
    { enabled: { type: "boolean" } }, ["enabled"], { duringReview: true, render: "none" }),
  prepare_clipboard_reference: read("Prepare a local exact-selection descriptor and native file-reference markup. Does not alter clipboard or chat.", { reference }, ["reference"]),
  inspect_reference: read("Resolve a copied cadproto reference from the retained exact cache.", { reference }, ["reference"]),
  add_reference_to_chat: command("Explicit alternative: add the current selection as a draft attachment without sending it. This is not the user-click clipboard workflow.",
    {}, ["expectedRevision"], { revision: "required", render: "none", duringReview: true }),
  set_visibility: command("Show or hide occurrences without moving the camera.", { ids, visible: { type: "boolean" } }, ["ids", "visible"]),
  isolate: command("Show only one occurrence and fit it.", { id: { type: "string" } }, ["id"]),
  show_all: command("Show all occurrences and fit the visible assembly."),
  set_view: command("Fit an isometric or exact axis view: right +X, left -X, back +Y, front -Y, top +Z, bottom -Z.", { preset: { enum: VIEW_PRESETS } }, ["preset"]),
  set_projection: command("Switch perspective or orthographic projection while retaining viewing direction and target-plane scale.", { projection: { enum: PROJECTIONS } }, ["projection"]),
  set_appearance: command("Choose Inspect or Studio and a visual finish. Source CAD colors and geometry stay unchanged.", {
    mode: { enum: ["inspect", "studio"] }, finish: { enum: MATERIAL_FINISHES }, showEdges: { type: "boolean" },
  }),
  set_section: command("Set one visual cutaway plane in original model-world millimeters. Display-derived caps do not modify, export or measure CAD geometry.", {
    enabled: { type: "boolean" },
    axis: { enum: SECTION_AXES },
    position: { type: "number", description: "Plane coordinate on the model's world axes, within the committed visible displayed bounds. Exploded offsets are visual, not physical measurements." },
    flipped: { type: "boolean", description: "False keeps coordinates at or below the plane; true keeps coordinates at or above it." },
  }),
  fit_view: command("Explicitly frame visible parts, including their exploded positions."),
  reset_view: command("Reassemble without moving the camera or changing STEP geometry."),
  load_file: command("Load a STEP snapshot inside the configured project root.", { file: { type: "string" } }, ["file"], { revision: "unchecked" }),
  load_demo: command("Load the synthetic demonstration assembly.", {}, [], { revision: "unchecked" }),
  capture_image: command("Save an image of the settled live view or annotated drawing, with source and pose metadata.",
    {}, [], { revision: "unchecked", render: "capture", duringReview: true }),
  list_reviews: read("List saved drawing review summaries."),
  get_review: read("Read a review's source, captured pose and mark count without image bytes.", { id: { type: "string" } }, ["id"]),
  open_review: command("Open a saved drawing review; its captured camera and model pose do not move.", { id: { type: "string" } }, ["id"],
    { render: "none", duringReview: true }),
  close_review: command("Return to the live model.", {}, [], { render: "none", duringReview: true }),
  save_camera: command("Persist the actual live camera.", {}, [], { revision: "required", render: "none", canvas: false }),
});

export function commandDefinition(name) {
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
}
