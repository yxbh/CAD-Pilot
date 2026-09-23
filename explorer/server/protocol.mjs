import { MATERIAL_FINISHES, PROJECTIONS, VIEW_PRESETS } from "../shared/view-settings.mjs";
import { commandDefinition } from "../shared/commands.mjs";
import {
  pruneSectionSelection, reconcileSectionWithDisplay, SECTION_AXES, sectionAxisIndex, sectionEntityVisible, sectionSupport, validateSection,
} from "../shared/section.mjs";
import { displayedWorldBounds } from "../shared/placement.mjs";

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
    selectionMode: "face", autoCopy: true, hiddenIds: [],
    explode: 0, fixedId: "", direction: "radial", cameraPreset: "iso", fitNonce: 0,
    loading: false, error: "",
    activeReviewId: null, camera: null,
    projection: "perspective", appearance: "inspect", materialFinish: "plastic", showEdges: true,
    section: { enabled: false, axis: "x", position: 0, flipped: false },
  };
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
    if (!Array.isArray(input.ids) || input.ids.length > 500) throw new PrototypeError("bad_selection", "Expected at most 500 part IDs");
    return [...new Set(input.ids.map(requireId))];
  };
  const next = { ...state, revision: state.revision + 1, error: "" };
  // Display changes keep the plane inside the visible pose and drop selections left wholly outside it.
  const followDisplay = () => Object.assign(next, pruneSectionSelection(reconcileSectionWithDisplay(next, model), model));
  switch (name) {
    case "select_parts":
      next.selectedIds = ids();
      next.selectedFace = null;
      next.selectedEdge = null;
      break;
    case "select_face": {
      if (input.topologyRevision !== model.topologyRevision) throw new PrototypeError("stale_topology", "Supply the exact displayed topology revision", 409);
      const nodeId = requireId(input.id);
      if (state.hiddenIds.includes(nodeId)) throw new PrototypeError("hidden_face", "Show this part before selecting its face", 409);
      const node = model.nodes.find((item) => item.id === nodeId);
      const part = model.parts.find((item) => item.id === node.partId);
      if (!part.faces.some((face) => face.id === input.faceId)) throw new PrototypeError("unknown_face", "Unknown CAD face on this occurrence");
      if (!sectionEntityVisible(model, state, nodeId, input.faceId)) throw new PrototypeError("section_hidden", "This CAD face is outside the retained section. Move or flip the section plane before selecting it.", 409);
      next.selectedIds = [nodeId];
      next.selectedFace = { nodeId, faceId: input.faceId };
      next.selectedEdge = null;
      next.selectionMode = "face";
      break;
    }
    case "select_edge": {
      if (input.topologyRevision !== model.topologyRevision) throw new PrototypeError("stale_topology", "Supply the exact displayed topology revision", 409);
      const nodeId = requireId(input.id);
      if (state.hiddenIds.includes(nodeId)) throw new PrototypeError("hidden_edge", "Show this part before selecting its edge", 409);
      const node = model.nodes.find((item) => item.id === nodeId);
      const part = model.parts.find((item) => item.id === node.partId);
      if (!part.edges?.some((edge) => edge.id === input.edgeId)) throw new PrototypeError("unknown_edge", "Unknown CAD edge on this occurrence");
      if (!sectionEntityVisible(model, state, nodeId, null, input.edgeId)) throw new PrototypeError("section_hidden", "This CAD edge is outside the retained section. Move or flip the section plane before selecting it.", 409);
      next.selectedIds = [nodeId];
      next.selectedFace = null;
      next.selectedEdge = { nodeId, edgeId: input.edgeId };
      next.selectionMode = "edge";
      break;
    }
    case "set_selection_mode":
      if (!["face", "edge", "part"].includes(input.mode)) throw new PrototypeError("bad_mode", "Choose face, edge or part selection");
      next.selectionMode = input.mode;
      next.selectedFace = null;
      next.selectedEdge = null;
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
      }
      if (input.direction !== undefined) {
        if (!["radial", "x", "y", "z"].includes(input.direction)) throw new PrototypeError("bad_direction", "Unsupported explosion direction");
        next.direction = input.direction;
      }
      if (input.fixedId !== undefined) next.fixedId = input.fixedId === "" ? "" : requireId(input.fixedId);
      followDisplay();
      break;
    case "set_visibility": {
      if (typeof input.visible !== "boolean") throw new PrototypeError("bad_visibility", "visible must be true or false");
      const selected = ids();
      next.hiddenIds = input.visible ? state.hiddenIds.filter((id) => !selected.includes(id)) : [...new Set([...state.hiddenIds, ...selected])];
      if (next.selectedFace && next.hiddenIds.includes(next.selectedFace.nodeId)) next.selectedFace = null;
      if (next.selectedEdge && next.hiddenIds.includes(next.selectedEdge.nodeId)) next.selectedEdge = null;
      followDisplay();
      break;
    }
    case "isolate":
      next.hiddenIds = [...valid].filter((id) => id !== requireId(input.id));
      if (next.selectedFace && next.hiddenIds.includes(next.selectedFace.nodeId)) next.selectedFace = null;
      if (next.selectedEdge && next.hiddenIds.includes(next.selectedEdge.nodeId)) next.selectedEdge = null;
      followDisplay();
      next.fitNonce++;
      next.camera = null;
      break;
    case "show_all":
      next.hiddenIds = [];
      followDisplay();
      next.fitNonce++;
      next.camera = null;
      break;
    case "set_view":
      if (!VIEW_PRESETS.includes(input.preset)) throw new PrototypeError("bad_view", "Choose iso, top, bottom, front, back, right or left");
      next.cameraPreset = input.preset;
      next.fitNonce++;
      next.camera = null;
      break;
    case "set_projection":
      if (!PROJECTIONS.includes(input.projection)) throw new PrototypeError("bad_projection", "Choose perspective or orthographic");
      next.projection = input.projection;
      break;
    case "set_appearance":
      if (input.mode === undefined && input.finish === undefined && input.showEdges === undefined) throw new PrototypeError("bad_appearance", "Supply a mode, finish or outline setting");
      if (input.mode !== undefined) {
        if (!["inspect", "studio"].includes(input.mode)) throw new PrototypeError("bad_appearance", "Choose inspect or studio");
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
      break;
    case "reset_view":
      next.explode = 0;
      next.fixedId = "";
      next.direction = "radial";
      followDisplay();
      break;
    default:
      throw new PrototypeError("unknown_command", `Unknown command: ${name}`);
  }
  return next;
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

export function validateModel(model, { requireRevision = true } = {}) {
  const fail = (message) => { throw new PrototypeError("invalid_model", message, 422); };
  const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  const bounds = (value) => value && vector(value.min, 3) && vector(value.max, 3) && value.min.every((number, axis) => number <= value.max[axis]);
  if (model?.schemaVersion !== 2 || model.units !== "mm" || !/^[a-f0-9]{64}$/.test(model.source?.sha256 || "")) fail("Invalid face-mapped model identity or units");
  if (!Array.isArray(model.parts) || !model.parts.length || !Array.isArray(model.nodes) || !bounds(model.bounds)) fail("Model has no usable geometry");
  const parts = new Set();
  for (const part of model.parts) {
    if (typeof part.id !== "string" || parts.has(part.id)) fail("Duplicate or invalid part ID");
    parts.add(part.id);
    if (!Array.isArray(part.positions) || !part.positions.length || part.positions.length % 3 || !part.positions.every(Number.isFinite)) fail("Invalid vertex positions");
    if (!vector(part.normals, part.positions.length) || !vector(part.color, 3) || !bounds(part.bounds)) fail("Invalid part normals, color or bounds");
    if (!Array.isArray(part.indices) || !part.indices.length || part.indices.length % 3 ||
        !part.indices.every((index) => Number.isInteger(index) && index >= 0 && index < part.positions.length / 3)) fail("Invalid triangle indices");
    if (!Array.isArray(part.faces) || !part.faces.length) fail("Missing CAD face map");
    if (part.sectionCaps !== undefined && typeof part.sectionCaps !== "boolean") fail("Invalid section-cap support metadata");
    let nextTriangle = 0;
    const faceIds = new Set();
    for (const face of part.faces) {
      if (!/^f[1-9][0-9]*$/.test(face.id) || faceIds.has(face.id) || face.triangleStart !== nextTriangle ||
          !Number.isInteger(face.triangleCount) || face.triangleCount <= 0 || !vector(face.center, 3) ||
          !bounds(face.bounds) || !Number.isFinite(face.area) || face.area <= 0 || typeof face.surfaceType !== "string") fail("Invalid CAD face mapping or properties");
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
            !edge.positions.every(Number.isFinite) || !vector(edge.center, 3) || !bounds(edge.bounds) ||
            !Number.isFinite(edge.length) || edge.length <= 0 || typeof edge.curveType !== "string" || !edge.curveType) fail("Invalid CAD edge mapping or properties");
        if (!edge.positions.some((value, index) => index >= 3 && value !== edge.positions[index % 3])) fail("CAD edge polyline has no length");
        if (edge.positions.some((value, index) => value < edge.bounds.min[index % 3] - 1e-6 || value > edge.bounds.max[index % 3] + 1e-6)) fail("CAD edge polyline exceeds native bounds");
        edgeIds.add(edge.id);
      }
    }
  }
  const nodes = new Set();
  for (const node of model.nodes) {
    if (typeof node.id !== "string" || nodes.has(node.id) || !vector(node.matrix, 16) || !vector(node.color, 3)) fail("Invalid assembly node");
    if (node.parentId !== null && !nodes.has(node.parentId)) fail("Parents must precede their children");
    if (node.partId !== null && !parts.has(node.partId)) fail("Assembly refers to missing geometry");
    nodes.add(node.id);
  }
  if (!model.nodes.some((node) => node.partId)) fail("No displayable part occurrences");
  if (!Array.isArray(model.warnings) || !model.warnings.every((warning) => typeof warning === "string")) fail("Invalid import diagnostics");
  if (model.cleanup !== undefined && !validCleanupCounts(model.cleanup, true)) fail("Invalid display cleanup diagnostics");
  // Early schema-2 edge snapshots used the original unsalted full-content hash.
  // Keep those copied references resolvable without changing their cache or identity.
  if (requireRevision && model.topologyRevision !== topologyRevision(model) &&
      model.topologyRevision !== topologyDigest(model)) fail("Cached model topology does not match its reference identity");
  return model;
}
import { createHash } from "node:crypto";
