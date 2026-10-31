import { MATERIAL_FINISHES, PROJECTIONS, VIEW_PRESETS } from "./view-settings.mjs";
import { SECTION_AXES } from "./section.mjs";
import { STEP_MODES } from "./placement.mjs";
import { MESH_UNITS, MESH_UP_AXES } from "./mesh.mjs";

export const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const ids = { type: "array", items: { type: "string" }, maxItems: 500 };
const revision = { type: "integer", minimum: 0 };
const reference = { type: "string", maxLength: 16384 };
const vector = (description) => ({ type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description });
const frame = {
  units: { enum: MESH_UNITS, description: "Mesh files only: the unit their numbers are in. auto uses the file's declared unit, else metres for models under 2.5 units across, else millimetres." },
  up: { enum: MESH_UP_AXES, description: "Mesh files only: the axis that points up in the file. auto is Y for OBJ and GLB, Z otherwise. Shown Z-up either way." },
};
const fileId = { type: "string", description: "A file in the view, as listed in state documents: main, ref1, ref2 ..." };

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
  get_state: read("Read a compact summary of the shown model (name, file, revision, generated time), its view and whether a viewer page has drawn it. detail=full adds parts, references and the renderer's report.", {
    detail: { enum: ["summary", "full"] },
  }),
  set_explode: command("Separate parts visually without moving the camera or changing the STEP. Fit assembly separately if needed.", {
    amount: { type: "number", minimum: 0, maximum: 1 },
    fixedId: { type: "string", description: "Occurrence to keep fixed, or empty to clear." },
    direction: { enum: ["radial", "x", "y", "z"], description: "radial moves each subassembly and part out from its parent's centre; x, y and z stack them along that axis in the order they sit." },
  }),
  set_step: command("Show a step of the STEP's assembly sequence (its .assembly.json) without moving the camera or changing the STEP. Step 0 shows every sequenced part waiting at its start offset; the last step is fully assembled; off=true leaves the sequence.", {
    step: { type: "integer", minimum: 0, maximum: 200 },
    mode: { enum: STEP_MODES, description: "exploded keeps later parts visible at their start offsets; buildup hides them until their step." },
    off: { type: "boolean", description: "true leaves the sequence and shows the assembled STEP. The design-project CLI also accepts step=null." },
  }),
  select_parts: command("Highlight occurrences without writing the clipboard.", { ids }, ["ids"]),
  select_face: command("Highlight a CAD face on the exact displayed topology, without writing the clipboard.", {
    id: { type: "string" }, faceId: { type: "string" }, topologyRevision: { type: "string" },
  }, ["id", "faceId", "topologyRevision"]),
  select_edge: command("Highlight a native CAD edge on the exact displayed topology, without writing the clipboard.", {
    id: { type: "string" }, edgeId: { type: "string" }, topologyRevision: { type: "string" },
  }, ["id", "edgeId", "topologyRevision"]),
  select_point: command("Highlight a picked point on a part's triangle, in part millimetres, without writing the clipboard. Works on meshes and STEP previews.", {
    id: { type: "string" }, triangle: { type: "integer", minimum: 0, description: "Triangle number in the part, counting from 0 in file order." },
    point: vector("Point on that triangle, in the part's own frame (mm)."), topologyRevision: { type: "string" },
  }, ["id", "triangle", "point", "topologyRevision"]),
  set_selection_mode: command("Choose face, edge, point or whole-part picking. Meshes have no CAD faces or edges: face and edge picking select their whole part.",
    { mode: { enum: ["face", "edge", "point", "part"] } }, ["mode"]),
  set_faults: command("Show or hide mesh faults: open edges (red), edges shared by more than two triangles (magenta), edges whose triangles wind the same way (orange) and zero-area triangles (yellow dots). Visual only; nothing is repaired.",
    { visible: { type: "boolean" } }, ["visible"]),
  set_auto_copy: command("Enable clipboard copying for future user selections. Selection never inserts or sends a chat message.",
    { enabled: { type: "boolean" } }, ["enabled"], { duringReview: true, render: "none" }),
  prepare_clipboard_reference: read("Prepare a local exact-selection descriptor and native file-reference markup. Does not alter clipboard or chat.", { reference }, ["reference"]),
  inspect_reference: read("Resolve a copied cadproto reference from the retained exact cache.", { reference }, ["reference"]),
  add_reference_to_chat: command("Explicit alternative: add the current selection as a draft attachment without sending it. This is not the user-click clipboard workflow.",
    {}, ["expectedRevision"], { revision: "required", render: "none", duringReview: true }),
  set_visibility: command("Show or hide occurrences without moving the camera.", { ids, visible: { type: "boolean" } }, ["ids", "visible"]),
  isolate: command("Show only one occurrence and fit it.", { id: { type: "string" } }, ["id"]),
  show_all: command("Show all occurrences and fit the visible assembly."),
  set_view: command("Fit an isometric or exact axis view (right +X, left -X, back +Y, front -Y, top +Z, bottom -Z), or a view from azimuth and elevation in degrees: azimuth 0 looks from the front, 90 from the right; elevation 90 looks down from the top.", {
    preset: { enum: VIEW_PRESETS },
    azimuth: { type: "number", minimum: -360, maximum: 360 },
    elevation: { type: "number", minimum: -90, maximum: 90 },
  }),
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
  load_file: command("Load a STEP, STL, OBJ, 3MF, PLY or GLB file inside the configured project root as the view's main file. Files added beside it stay; remove them with remove_file. Meshes are shown as they are, not converted to CAD.",
    { file: { type: "string" }, ...frame }, ["file"], { revision: "unchecked" }),
  add_file: command("Add another file to the view in its own frame, for example a scan or the original model to compare against. Each file keeps its own references.", {
    file: { type: "string" }, ...frame,
    style: { enum: ["solid", "ghost"], description: "ghost (the default) draws it see-through, as a reference that clicks in the view pass through; its parts can still be selected from the parts list or with select_parts." },
  }, ["file"]),
  set_file: command("Restyle or move a file in the view. Placement is visual and does not change the file or its references.", {
    id: fileId, style: { enum: ["solid", "ghost"] },
    offset: vector("Move by X, Y and Z (mm)."), rotate: vector("Turn about X, then Y, then Z (degrees), before moving."),
  }, ["id"]),
  remove_file: command("Remove an added file from the view. Open another main file with load_file.", { id: fileId }, ["id"]),
  set_layout: command("Compare files overlaid in one place (overlay) or side by side along X (side), under one camera.",
    { mode: { enum: ["overlay", "side"] } }, ["mode"]),
  load_demo: command("Load the synthetic demonstration assembly.", {}, [], { revision: "unchecked" }),
  capture_image: command("Save a PNG of the current view or annotated drawing, with source and pose metadata. It is drawn in the background at a fixed size, so no viewer page needs to be open or visible.", {
    width: { type: "integer", minimum: 16, maximum: 4096 },
    height: { type: "integer", minimum: 16, maximum: 4096 },
    background: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: "Background colour for this image only, such as #ffffff." },
  }, [], { revision: "unchecked", render: "capture", duringReview: true }),
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
