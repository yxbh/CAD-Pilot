import { createHash } from "node:crypto";
import { APPEARANCES, MATERIAL_FINISHES, PROJECTIONS, VIEW_PRESETS, viewAngle } from "../shared/view-settings.mjs";
import { commandDefinition, MAX_PART_IDS } from "../shared/commands.mjs";
import {
  defaultSection, pruneSectionSelection, reconcileSectionWithDisplay, SECTION_AXES, sectionAxisIndex, sectionEntityVisible, sectionSupport, validateSection,
} from "../shared/section.mjs";
import { displayedWorldBounds, sequenceOffsets, sequencePose, STEP_MODES } from "../shared/placement.mjs";
import { attachMeshGeometry, MESH_FORMATS, meshViews, pointOnTriangle, triangleCorners } from "../shared/mesh.mjs";
import { referenceEntity, roundPoint } from "../shared/references.mjs";
import { applyAnalysis, defaultAnalysis } from "../shared/analysis.mjs";

export const SELECTION_MODES = Object.freeze(["face", "edge", "point", "part"]);

export class PrototypeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function initialState() {
  return {
    revision: 0, documentRevision: "", topologyRevision: "", modelName: "", selectedIds: [], selectedFace: null, selectedEdge: null,
    selectedPoint: null, selectionMode: "face", autoCopy: true, hiddenIds: [], documents: [], layout: "overlay", showFaults: false,
    explode: 0, fixedId: "", direction: "radial", cameraPreset: "iso", fitNonce: 0,
    assembly: null, step: null, stepMode: "exploded",
    loading: false, error: "",
    activeReviewId: null, camera: null, cameraPinned: false,
    projection: "perspective", appearance: "inspect", materialFinish: "plastic", showEdges: true, analysis: defaultAnalysis(),
    section: { enabled: false, axis: "x", position: 0, flipped: false },
    // Where the main file came from: project-relative path (empty for uploads and the demo), its modified time, size
    // and SHA-256, which is the revision a person is told about; documentRevision identifies the whole view.
    source: { file: "", generatedAt: "", size: 0, sha256: "" },
    // Whether the last reload kept the previous view (null before any reload).
    viewKept: null,
    // Added files that a restore had to leave out, because Explorer's copy was gone and the file could not be read again.
    droppedFiles: [],
  };
}

// Display preferences belong to the person, not to one model, so a newly loaded STEP keeps them.
const preferences = ["autoCopy", "selectionMode", "projection", "appearance", "materialFinish", "showEdges", "analysis", "cameraPreset"];

// Regenerating a design keeps the view when every occurrence keeps its id, parent, kind and name in the assembly tree.
// Unnamed parts are named after the file people opened, never its snapshot, so a regeneration keeps their names too.
export function sameAssemblyTree(previous, next) {
  if (!previous || previous.nodes.length !== next.nodes.length) return false;
  return previous.nodes.every((node, index) => {
    const other = next.nodes[index];
    return node.id === other.id && node.parentId === other.parentId && !node.partId === !other.partId && node.label === other.label;
  });
}

// Only a regeneration of the same file keeps its view: an unrelated STEP can share node ids (they are positions in
// the file) and unnamed labels. Uploads have no project path, so they compare by file name. A mesh read in other
// units or with another up axis is another model, not a regeneration.
const sameFrame = (previous, next) => previous?.units === next?.units && previous?.up === next?.up;
const sameSource = (state, loaded) => (loaded.source.file ? loaded.source.file === state.source.file
  : !state.source.file && loaded.modelName === state.modelName) && sameFrame(state.documents?.[0]?.frame, loaded.documents?.[0]?.frame);

/** The state for a newly loaded model: the previous view where the same file's assembly tree still matches, otherwise its defaults. */
export function loadedView(state, previousModel, model, loaded) {
  const base = { ...initialState(), ...Object.fromEntries(preferences.map((key) => [key, state[key]])), ...loaded, revision: state.revision };
  if (!sameSource(state, loaded) || !sameAssemblyTree(previousModel, model)) {
    return { ...base, section: defaultSection(model.bounds), fitNonce: state.fitNonce + 1, viewKept: previousModel ? false : null };
  }
  const steps = loaded.assembly?.steps.length ?? 0;
  const next = {
    ...base, fitNonce: state.fitNonce, viewKept: true,
    hiddenIds: state.hiddenIds, selectedIds: state.selectedIds, explode: state.explode, direction: state.direction, fixedId: state.fixedId,
    step: state.step !== null && state.step <= steps ? state.step : null, stepMode: state.stepMode,
    // A camera the person moved is theirs; a fitted one is fitted again to the regenerated geometry.
    camera: state.cameraPinned ? state.camera : null, cameraPinned: state.cameraPinned,
    ...(state.cameraPinned ? {} : { fitNonce: state.fitNonce + 1 }),
    section: { ...state.section, enabled: state.section.enabled && sectionSupport(model).supported },
  };
  return pruneSectionSelection(reconcileSectionWithDisplay(next, model), model);
}

export function changeView(state, model, name, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PrototypeError("bad_input", "Command input must be an object");
  validateCommandRevision(state, name, input.expectedRevision);
  if (input.topologyRevision !== undefined && input.topologyRevision !== model?.topologyRevision) {
    throw new PrototypeError("stale_topology", "This reference belongs to an older model. Select the geometry again.", 409);
  }
  if (name === "set_auto_copy") {
    if (typeof input.enabled !== "boolean") throw new PrototypeError("bad_auto_copy", "Auto-copy must be enabled or disabled");
    return { ...state, revision: state.revision + 1, autoCopy: input.enabled };
  }
  if (!model || state.loading) throw new PrototypeError("not_ready", "Wait for STEP conversion to finish", 409);
  const valid = new Set(model.nodes.filter((node) => node.partId).map((node) => node.id));
  const requireId = (id) => {
    if (typeof id !== "string" || !valid.has(id)) throw new PrototypeError("unknown_part", `Unknown part: ${String(id)}`);
    return id;
  };
  const ids = () => {
    if (!Array.isArray(input.ids) || input.ids.length > MAX_PART_IDS) throw new PrototypeError("bad_selection", `Expected at most ${MAX_PART_IDS} part IDs`);
    return [...new Set(input.ids.map(requireId))];
  };
  // Whether a reload kept the view is news only until the next view change.
  const next = { ...state, revision: state.revision + 1, error: "", viewKept: null };
  // Display changes keep the plane inside the visible pose and drop selections left wholly outside it.
  const followDisplay = () => Object.assign(next, pruneSectionSelection(reconcileSectionWithDisplay(next, model), model));
  switch (name) {
    case "select_parts":
      next.selectedIds = ids();
      next.selectedFace = null;
      next.selectedEdge = null;
      next.selectedPoint = null;
      break;
    case "select_face": {
      if (input.topologyRevision !== model.topologyRevision) throw new PrototypeError("stale_topology", "Supply the exact displayed topology revision", 409);
      const nodeId = requireId(input.id);
      if (state.hiddenIds.includes(nodeId) || sequenceHidden(state).has(nodeId)) throw new PrototypeError("hidden_face", "Show this part before selecting its face", 409);
      const node = model.nodes.find((item) => item.id === nodeId);
      const part = model.parts.find((item) => item.id === node.partId);
      if (!part.faces.some((face) => face.id === input.faceId)) throw new PrototypeError("unknown_face", "Unknown CAD face on this occurrence");
      if (!sectionEntityVisible(model, state, nodeId, input.faceId)) throw new PrototypeError("section_hidden", "This CAD face is outside the retained section. Move or flip the section plane before selecting it.", 409);
      next.selectedIds = [nodeId];
      next.selectedFace = { nodeId, faceId: input.faceId };
      next.selectedEdge = null;
      next.selectedPoint = null;
      next.selectionMode = "face";
      break;
    }
    case "select_edge": {
      if (input.topologyRevision !== model.topologyRevision) throw new PrototypeError("stale_topology", "Supply the exact displayed topology revision", 409);
      const nodeId = requireId(input.id);
      if (state.hiddenIds.includes(nodeId) || sequenceHidden(state).has(nodeId)) throw new PrototypeError("hidden_edge", "Show this part before selecting its edge", 409);
      const node = model.nodes.find((item) => item.id === nodeId);
      const part = model.parts.find((item) => item.id === node.partId);
      if (!part.edges?.some((edge) => edge.id === input.edgeId)) throw new PrototypeError("unknown_edge", "Unknown CAD edge on this occurrence");
      if (!sectionEntityVisible(model, state, nodeId, null, input.edgeId)) throw new PrototypeError("section_hidden", "This CAD edge is outside the retained section. Move or flip the section plane before selecting it.", 409);
      next.selectedIds = [nodeId];
      next.selectedFace = null;
      next.selectedEdge = { nodeId, edgeId: input.edgeId };
      next.selectedPoint = null;
      next.selectionMode = "edge";
      break;
    }
    case "select_point": {
      if (input.topologyRevision !== model.topologyRevision) throw new PrototypeError("stale_topology", "Supply the exact displayed topology revision", 409);
      const nodeId = requireId(input.id);
      if (state.hiddenIds.includes(nodeId) || sequenceHidden(state).has(nodeId)) throw new PrototypeError("hidden_point", "Show this part before picking a point on it", 409);
      const node = model.nodes.find((item) => item.id === nodeId);
      const part = model.parts.find((item) => item.id === node.partId);
      const point = { triangle: input.triangle, point: Array.isArray(input.point) ? roundPoint(input.point) : input.point };
      try { referenceEntity(model, nodeId, null, null, point); }
      catch (error) { throw new PrototypeError("bad_point", error.message); }
      if (pointOnTriangle(triangleCorners(part, point.triangle), point.point, part.bounds) === null) throw new PrototypeError("bad_point", "The point is not on that triangle of the part");
      if (!sectionEntityVisible(model, state, nodeId, null, null, point.point)) throw new PrototypeError("section_hidden", "This point is outside the retained section. Move or flip the section plane before picking it.", 409);
      next.selectedIds = [nodeId];
      next.selectedFace = null;
      next.selectedEdge = null;
      next.selectedPoint = { nodeId, ...point };
      next.selectionMode = "point";
      break;
    }
    case "set_selection_mode":
      if (!SELECTION_MODES.includes(input.mode)) throw new PrototypeError("bad_mode", "Choose face, edge, point or part selection");
      next.selectionMode = input.mode;
      next.selectedFace = null;
      next.selectedEdge = null;
      next.selectedPoint = null;
      break;
    case "set_faults":
      if (typeof input.visible !== "boolean") throw new PrototypeError("bad_faults", "visible must be true or false");
      next.showFaults = input.visible;
      break;
    case "set_explode":
      if (input.amount === undefined && input.direction === undefined && input.fixedId === undefined) {
        throw new PrototypeError("bad_explosion", "Supply an amount, direction or fixed part");
      }
      if (input.amount !== undefined) {
        if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount < 0 || input.amount > 1) {
          throw new PrototypeError("bad_amount", "Explosion amount must be between 0 and 1");
        }
        if (input.amount > 0 && valid.size < 2) throw new PrototypeError("not_assembly", "This model has no separate parts to explode");
        next.explode = input.amount;
        // Automatic explosion and the assembly sequence are alternative ways to separate parts.
        if (input.amount > 0) next.step = null;
      }
      if (input.direction !== undefined) {
        if (!["radial", "x", "y", "z"].includes(input.direction)) throw new PrototypeError("bad_direction", "Unsupported explosion direction");
        next.direction = input.direction;
      }
      if (input.fixedId !== undefined) next.fixedId = input.fixedId === "" ? "" : requireId(input.fixedId);
      followDisplay();
      break;
    case "set_step": {
      if (input.off !== undefined && typeof input.off !== "boolean") throw new PrototypeError("bad_step", "off must be true or false");
      if (input.off === true && input.step !== undefined && input.step !== null) throw new PrototypeError("bad_step", "Choose a step or off, not both");
      if (input.step === undefined && input.mode === undefined && input.off !== true) throw new PrototypeError("bad_step", "Supply a step number, off=true or a mode");
      const steps = state.assembly?.steps ?? [];
      if (input.step !== undefined && input.step !== null) {
        if (!steps.length) throw new PrototypeError("no_sequence", "This STEP has no assembly sequence. Write one beside it as <name>.assembly.json and open the STEP again.", 409);
        if (!Number.isInteger(input.step) || input.step < 0 || input.step > steps.length) {
          throw new PrototypeError("bad_step", `Step must be a whole number from 0 to ${steps.length}`);
        }
        next.explode = 0;
      }
      if (input.step !== undefined) next.step = input.step;
      if (input.off === true) next.step = null;
      if (input.mode !== undefined) {
        if (!STEP_MODES.includes(input.mode)) throw new PrototypeError("bad_step_mode", "Choose exploded or buildup");
        next.stepMode = input.mode;
      }
      const hidden = sequenceHidden(next);
      dropHiddenSelection(next, hidden);
      followDisplay();
      break;
    }
    case "set_visibility": {
      if (typeof input.visible !== "boolean") throw new PrototypeError("bad_visibility", "visible must be true or false");
      const selected = ids();
      next.hiddenIds = input.visible ? state.hiddenIds.filter((id) => !selected.includes(id)) : [...new Set([...state.hiddenIds, ...selected])];
      dropHiddenSelection(next, new Set(next.hiddenIds));
      followDisplay();
      break;
    }
    case "isolate":
      next.hiddenIds = [...valid].filter((id) => id !== requireId(input.id));
      dropHiddenSelection(next, new Set(next.hiddenIds));
      followDisplay();
      next.fitNonce++;
      next.camera = null;
      next.cameraPinned = false;
      break;
    case "show_all":
      next.hiddenIds = [];
      followDisplay();
      next.fitNonce++;
      next.camera = null;
      next.cameraPinned = false;
      break;
    case "set_view":
      if (input.preset !== undefined && (input.azimuth !== undefined || input.elevation !== undefined)) {
        throw new PrototypeError("bad_view", "Choose a preset or an azimuth and elevation, not both");
      }
      if (input.preset === undefined) {
        try { next.cameraPreset = viewAngle(input.azimuth, input.elevation); }
        catch (error) { throw new PrototypeError("bad_view", error.message); }
      } else if (!VIEW_PRESETS.includes(input.preset)) throw new PrototypeError("bad_view", "Choose iso, top, bottom, front, back, right or left");
      else next.cameraPreset = input.preset;
      next.fitNonce++;
      next.camera = null;
      next.cameraPinned = false;
      break;
    case "set_projection":
      if (!PROJECTIONS.includes(input.projection)) throw new PrototypeError("bad_projection", "Choose perspective or orthographic");
      next.projection = input.projection;
      break;
    case "set_appearance":
      if (input.mode === undefined && input.finish === undefined && input.showEdges === undefined) throw new PrototypeError("bad_appearance", "Supply a mode, finish or outline setting");
      if (input.mode !== undefined) {
        if (!APPEARANCES.includes(input.mode)) throw new PrototypeError("bad_appearance", "Choose inspect, studio or raytraced");
        next.appearance = input.mode;
      }
      if (input.finish !== undefined) {
        if (!MATERIAL_FINISHES.includes(input.finish)) throw new PrototypeError("bad_finish", "Choose plastic, satin, polished or rubber");
        next.materialFinish = input.finish;
      }
      if (input.showEdges !== undefined) {
        if (typeof input.showEdges !== "boolean") throw new PrototypeError("bad_edges", "Outlines must be enabled or disabled");
        next.showEdges = input.showEdges;
      } else if (input.mode !== undefined && input.mode !== state.appearance) next.showEdges = input.mode === "inspect";
      break;
    case "set_analysis": {
      const { expectedRevision, ...settings } = input;
      if (!Object.keys(settings).length) throw new PrototypeError("bad_analysis", "Supply a map or an overlay or setting to change");
      next.analysis = analysisInput(state.analysis, settings);
      break;
    }
    case "set_section": {
      if (input.enabled === undefined && input.axis === undefined && input.position === undefined && input.flipped === undefined) {
        throw new PrototypeError("bad_section", "Supply an enabled flag, X/Y/Z axis, model-world position or flipped side");
      }
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new PrototypeError("bad_section", "Section enabled must be true or false");
      if (input.axis !== undefined && !SECTION_AXES.includes(input.axis)) throw new PrototypeError("bad_section", "Section axis must be X, Y or Z");
      if (input.flipped !== undefined && typeof input.flipped !== "boolean") throw new PrototypeError("bad_section", "Section flipped must be true or false");
      if (input.position !== undefined && (typeof input.position !== "number" || !Number.isFinite(input.position))) {
        throw new PrototypeError("bad_section_position", "Section position must be a finite model-world millimeter value");
      }
      const displayBounds = displayedWorldBounds(model, state);
      if (!displayBounds && (input.axis !== undefined || input.position !== undefined)) {
        throw new PrototypeError("section_no_visible_parts", "Show a part before changing the section plane axis or position", 409);
      }
      const axis = input.axis ?? state.section.axis;
      const axisNumber = sectionAxisIndex(axis);
      const position = input.position ?? (input.axis !== undefined && input.axis !== state.section.axis
        ? (displayBounds.min[axisNumber] + displayBounds.max[axisNumber]) / 2
        : state.section.position);
      const section = {
        enabled: input.enabled ?? state.section.enabled,
        axis,
        position,
        flipped: input.flipped ?? state.section.flipped,
      };
      try { validateSection(section, displayBounds ?? undefined); }
      catch (error) {
        throw new PrototypeError(error instanceof RangeError ? "bad_section_position" : "bad_section", error.message);
      }
      const support = sectionSupport(model);
      if (section.enabled && !support.supported) throw new PrototypeError("section_unsupported", support.message, 422);
      next.section = section;
      Object.assign(next, pruneSectionSelection(next, model));
      break;
    }
    case "fit_view":
      next.fitNonce++;
      next.camera = null;
      next.cameraPinned = false;
      break;
    case "reset_view":
      next.explode = 0;
      next.fixedId = "";
      next.direction = "radial";
      next.step = null;
      followDisplay();
      break;
    default:
      throw new PrototypeError("unknown_command", `Unknown command: ${name}`);
  }
  return next;
}

/** The view's analysis settings with an input applied, for set_analysis and a capture's own settings. */
export function analysisInput(current, input) {
  try { return applyAnalysis(current, input); }
  catch (error) { throw new PrototypeError("bad_analysis", error.message); }
}

function sequenceHidden(state) {
  return sequenceOffsets(sequencePose(state)).hidden;
}

function dropHiddenSelection(next, hidden) {
  for (const key of ["selectedFace", "selectedEdge", "selectedPoint"]) if (next[key] && hidden.has(next[key].nodeId)) next[key] = null;
}


export function validateCommandRevision(state, name, expectedRevision, message = "The view changed. Refresh state and retry.") {
  const definition = commandDefinition(name);
  if (!definition) throw new PrototypeError("unknown_command", `Unknown command: ${name}`);
  if (definition.revision !== "unchecked" && (definition.revision === "required" || expectedRevision !== undefined) &&
      expectedRevision !== state.revision) {
    throw new PrototypeError("stale_view", message, 409);
  }
}

function topologyDigest(model, conversionVersion) {
  return createHash("sha256").update(JSON.stringify({
    ...(conversionVersion ? { conversionVersion } : {}),
    schemaVersion: model.schemaVersion, sourceHash: model.source.sha256,
    units: model.units, parts: model.parts, nodes: model.nodes,
  })).digest("hex");
}

export function topologyRevision(model) {
  // A mesh's identity covers its frame (units and up axis) and the exact geometry file, not only the manifest.
  if (model.kind === "mesh") {
    return createHash("sha256").update(JSON.stringify({
      conversionVersion: "mesh-v1", schemaVersion: model.schemaVersion, source: { sha256: model.source.sha256, format: model.source.format },
      units: model.units, frame: model.frame, geometry: model.geometry, parts: model.parts, nodes: model.nodes,
    })).digest("hex");
  }
  // Preserve face-only addresses; new edge caches have an independent converter version.
  // Closed-solid metadata belongs to each part record: caches without it keep their identity; newer imports differ.
  return topologyDigest(model, model.parts.some((part) => part.edges !== undefined) ? "native-edges-v1" : undefined);
}

function validCleanupCounts(cleanup, allowUnknown) {
  return cleanup && typeof cleanup === "object" && !Array.isArray(cleanup) && Object.keys(cleanup).length === 2 &&
    ["degenerateEdges", "zeroAreaTriangles"].every((key) =>
      (allowUnknown && cleanup[key] === null) || (Number.isSafeInteger(cleanup[key]) && cleanup[key] >= 0 &&
        cleanup[key] <= (key === "degenerateEdges" ? 200_000 : 1_000_000)));
}

export function validateMeasuredCleanup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
      typeof value.topologyRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.topologyRevision) ||
      !validCleanupCounts(value.counts, false)) {
    throw new PrototypeError("invalid_saved_cleanup", "Invalid saved measured cleanup diagnostics", 422);
  }
  return value;
}

const fail = (message) => { throw new PrototypeError("invalid_model", message, 422); };
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const validBounds = (value) => value && vector(value.min, 3) && vector(value.max, 3) && value.min.every((number, axis) => number <= value.max[axis]);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function validateNodes(model, parts) {
  const nodes = new Set();
  for (const node of model.nodes) {
    if (typeof node.id !== "string" || nodes.has(node.id) || !vector(node.matrix, 16) || !vector(node.color, 3)) fail("Invalid assembly node");
    if (node.parentId !== null && !nodes.has(node.parentId)) fail("Parents must precede their children");
    if (node.partId !== null && !parts.has(node.partId)) fail("Assembly refers to missing geometry");
    nodes.add(node.id);
  }
  if (!model.nodes.some((node) => node.partId)) fail("No displayable part occurrences");
  if (!Array.isArray(model.warnings) || !model.warnings.every((warning) => typeof warning === "string")) fail("Invalid import diagnostics");
}

// The manifest only; validateMeshGeometry checks the binary file it describes.
function validateMeshModel(model, requireRevision) {
  if (model.schemaVersion !== 2 || model.units !== "mm" || !/^[a-f0-9]{64}$/.test(model.source?.sha256 || "") ||
      !MESH_FORMATS.includes(model.source.format)) fail("Invalid mesh identity, format or units");
  const frame = model.frame;
  if (!frame || typeof frame.units !== "string" || !Number.isFinite(frame.scale) || frame.scale <= 0 ||
      !["z", "y"].includes(frame.up) || typeof frame.note !== "string") fail("Invalid mesh frame");
  if (!count(model.geometry?.bytes) || !/^[a-f0-9]{64}$/.test(model.geometry.sha256 || "")) fail("Invalid mesh geometry identity");
  if (!Array.isArray(model.parts) || !model.parts.length || !Array.isArray(model.nodes) || !validBounds(model.bounds)) fail("Mesh has no usable geometry");
  const parts = new Set();
  for (const part of model.parts) {
    if (typeof part.id !== "string" || parts.has(part.id) || typeof part.label !== "string") fail("Duplicate or invalid mesh part");
    parts.add(part.id);
    if (!vector(part.color, 3) || !validBounds(part.bounds) || !count(part.vertexCount) || part.vertexCount < 3 ||
        !count(part.triangleCount) || part.triangleCount < 1 || typeof part.closed !== "boolean" || part.sectionCaps !== part.closed ||
        !Array.isArray(part.faces) || part.faces.length || part.edges !== undefined) fail("Invalid mesh part record");
    const expected = {
      positions: part.vertexCount * 3, indices: part.triangleCount * 3, outlines: null,
      openEdges: part.faults?.openEdges * 2, oversharedEdges: part.faults?.oversharedEdges * 2,
      flippedEdges: part.faults?.flippedEdges * 2, degenerateTriangles: part.faults?.degenerateTriangles,
    };
    for (const [name, length] of Object.entries(expected)) {
      const buffer = part.buffers?.[name];
      if (!buffer || !count(buffer.offset) || buffer.offset % 4 || !count(buffer.count) ||
          (length === null ? buffer.count % 2 : buffer.count !== length) || buffer.offset + buffer.count * 4 > model.geometry.bytes) {
        fail(`Invalid mesh ${name} buffer`);
      }
    }
  }
  validateNodes(model, parts);
  if (requireRevision && model.topologyRevision !== topologyRevision(model)) fail("Cached mesh does not match its reference identity");
  return model;
}

// Checks the geometry file against its manifest and attaches its typed views to each part.
export function validateMeshGeometry(model, bytes) {
  if (bytes.length !== model.geometry.bytes || createHash("sha256").update(bytes).digest("hex") !== model.geometry.sha256) {
    fail("Mesh geometry file does not match its manifest");
  }
  for (const part of model.parts) {
    const views = meshViews(part, bytes);
    for (const value of views.positions) if (!Number.isFinite(value)) fail("Mesh has a non-finite vertex position");
    for (const name of ["indices", "outlines", "openEdges", "oversharedEdges", "flippedEdges"]) {
      for (const index of views[name]) if (index >= part.vertexCount) fail(`Mesh ${name} refer to a missing vertex`);
    }
    for (const triangle of views.degenerateTriangles) if (triangle >= part.triangleCount) fail("Mesh fault list refers to a missing triangle");
    attachMeshGeometry(part, views);
  }
  // The verified bytes stay with the model, so a running viewer serves them without reading the store again.
  Object.defineProperty(model, "geometryBytes", { value: bytes, enumerable: false, configurable: true, writable: false });
  return model;
}

export function validateModel(model, { requireRevision = true } = {}) {
  if (model?.kind === "mesh") return validateMeshModel(model, requireRevision);
  if (model?.schemaVersion !== 2 || model.units !== "mm" || !/^[a-f0-9]{64}$/.test(model.source?.sha256 || "")) fail("Invalid face-mapped model identity or units");
  if (!Array.isArray(model.parts) || !model.parts.length || !Array.isArray(model.nodes) || !validBounds(model.bounds)) fail("Model has no usable geometry");
  const parts = new Set();
  for (const part of model.parts) {
    if (typeof part.id !== "string" || parts.has(part.id)) fail("Duplicate or invalid part ID");
    parts.add(part.id);
    if (!Array.isArray(part.positions) || !part.positions.length || part.positions.length % 3 || !part.positions.every(Number.isFinite)) fail("Invalid vertex positions");
    if (!vector(part.normals, part.positions.length) || !vector(part.color, 3) || !validBounds(part.bounds)) fail("Invalid part normals, color or bounds");
    if (!Array.isArray(part.indices) || !part.indices.length || part.indices.length % 3 ||
        !part.indices.every((index) => Number.isInteger(index) && index >= 0 && index < part.positions.length / 3)) fail("Invalid triangle indices");
    if (!Array.isArray(part.faces) || !part.faces.length) fail("Missing CAD face map");
    if (part.sectionCaps !== undefined && typeof part.sectionCaps !== "boolean") fail("Invalid section-cap support metadata");
    let nextTriangle = 0;
    const faceIds = new Set();
    for (const face of part.faces) {
      if (!/^f[1-9][0-9]*$/.test(face.id) || faceIds.has(face.id) || face.triangleStart !== nextTriangle ||
          !Number.isInteger(face.triangleCount) || face.triangleCount <= 0 || !vector(face.center, 3) ||
          !validBounds(face.bounds) || !Number.isFinite(face.area) || face.area <= 0 || typeof face.surfaceType !== "string") fail("Invalid CAD face mapping or properties");
      faceIds.add(face.id);
      nextTriangle += face.triangleCount;
    }
    if (nextTriangle !== part.indices.length / 3) fail("CAD face map does not cover the final triangles exactly");
    // Old schema-2 caches remain immutable and inspectable without an edge map.
    if (part.edges !== undefined) {
      if (!Array.isArray(part.edges)) fail("Invalid CAD edge map");
      const edgeIds = new Set();
      for (const edge of part.edges) {
        if (!edge || !/^e[1-9][0-9]*$/.test(edge.id) || edgeIds.has(edge.id) ||
            !Array.isArray(edge.positions) || edge.positions.length < 6 || edge.positions.length % 3 ||
            !edge.positions.every(Number.isFinite) || !vector(edge.center, 3) || !validBounds(edge.bounds) ||
            !Number.isFinite(edge.length) || edge.length <= 0 || typeof edge.curveType !== "string" || !edge.curveType) fail("Invalid CAD edge mapping or properties");
        if (!edge.positions.some((value, index) => index >= 3 && value !== edge.positions[index % 3])) fail("CAD edge polyline has no length");
        if (edge.positions.some((value, index) => value < edge.bounds.min[index % 3] - 1e-6 || value > edge.bounds.max[index % 3] + 1e-6)) fail("CAD edge polyline exceeds native bounds");
        edgeIds.add(edge.id);
      }
    }
  }
  validateNodes(model, parts);
  if (model.cleanup !== undefined && !validCleanupCounts(model.cleanup, true)) fail("Invalid display cleanup diagnostics");
  // Early schema-2 edge snapshots used the original unsalted full-content hash.
  // Keep those copied references resolvable without changing their cache or identity.
  if (requireRevision && model.topologyRevision !== topologyRevision(model) &&
      model.topologyRevision !== topologyDigest(model)) fail("Cached model topology does not match its reference identity");
  return model;
}
