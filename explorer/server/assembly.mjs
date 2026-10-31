import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isInside } from "./paths.mjs";
import { PrototypeError } from "./protocol.mjs";

export const ASSEMBLY_FORMAT = "cad-explorer-assembly";
const maxBytes = 1024 * 1024;
const maxSteps = 200;
const checkStatuses = ["clear", "blocked", "interferes", "error"];

// The sequence file sits beside its STEP: outputs/part.step -> outputs/part.assembly.json.
export function sequencePath(stepPath) {
  return path.join(path.dirname(stepPath), `${path.basename(stepPath, path.extname(stepPath))}.assembly.json`);
}

const text = (value, limit) => typeof value === "string" && value.length <= limit;
// Only * and ? are wildcards; every other character, brackets included, is literal.
const labelPattern = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s");

function validateDocument(document) {
  const fail = (message) => { throw new PrototypeError("invalid_sequence", `Assembly sequence: ${message}`, 422); };
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("expected a JSON object");
  if (document.format !== ASSEMBLY_FORMAT || document.version !== 1) fail(`expected format "${ASSEMBLY_FORMAT}" version 1`);
  if (document.units !== undefined && document.units !== "mm") fail("units must be mm");
  if (document.step !== undefined && (!document.step || typeof document.step.sha256 !== "string")) fail("step must record the STEP's sha256");
  if (!Array.isArray(document.steps) || !document.steps.length || document.steps.length > maxSteps) fail(`expected 1 to ${maxSteps} steps`);
  document.steps.forEach((step, index) => {
    const label = `step ${index + 1}`;
    if (!step || typeof step !== "object" || Array.isArray(step)) fail(`${label} must be an object`);
    if (!text(step.title, 200) || !step.title.trim()) fail(`${label} needs a title of at most 200 characters`);
    if (step.note !== undefined && !text(step.note, 1000)) fail(`${label} note must be at most 1000 characters`);
    if (!Array.isArray(step.parts) || !step.parts.length || step.parts.length > 100 || !step.parts.every((part) => text(part, 200) && part)) {
      fail(`${label} needs 1 to 100 part labels`);
    }
    if (!Array.isArray(step.from) || step.from.length !== 3 || !step.from.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e5)) {
      fail(`${label} from must be three finite millimetre values`);
    }
    if (step.check !== undefined && (!step.check || !checkStatuses.includes(step.check.status) || !text(step.check.detail ?? "", 1000))) {
      fail(`${label} has an invalid check result`);
    }
  });
  return document;
}

// Part patterns, wherever a person names parts (sequence steps, a render's hidden parts): labels resolve against
// every node, with * and ? as the only wildcards, and a group label stands for all of its parts. A group holding
// every part (the top-level assembly, or a wrapper around it) never matches: a step that moved the whole model would
// have nothing to arrive at, and a pattern such as "Anchor *" written for parts must not catch an "Anchor v3" root.
// Returns a resolver from patterns to the part occurrences' node ids and the patterns that matched nothing.
export function partResolver(model) {
  const children = new Map();
  for (const node of model.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const leavesOf = (node) => node.partId ? [node.id] : (children.get(node.id) ?? []).flatMap(leavesOf);
  const partCount = model.nodes.filter((node) => node.partId).length;
  const candidates = model.nodes.filter((node) => node.partId || leavesOf(node).length < partCount);
  const resolve = (patterns) => {
    const nodeIds = [];
    const unresolved = [];
    for (const pattern of patterns) {
      const matcher = labelPattern(pattern);
      const matches = candidates.filter((node) => matcher.test(node.label));
      if (!matches.length) unresolved.push(pattern);
      for (const id of matches.flatMap(leavesOf)) if (!nodeIds.includes(id)) nodeIds.push(id);
    }
    return { nodeIds, unresolved };
  };
  return Object.assign(resolve, { partCount });
}

export function resolveSequence(document, model, file) {
  validateDocument(document);
  const resolve = partResolver(model);
  const steps = document.steps.map((step, index) => {
    const { nodeIds, unresolved } = resolve(step.parts);
    // A step moving every part has nothing to arrive at; the exporter refuses it, and so does the viewer.
    if (nodeIds.length === resolve.partCount) {
      throw new PrototypeError("invalid_sequence", `Assembly sequence: step ${index + 1} moves every part (${step.parts.join(", ")}); name only the parts that arrive in that step`, 422);
    }
    return {
      title: step.title.trim(), note: step.note?.trim() ?? "", parts: step.parts, nodeIds, unresolved, from: step.from,
      ...(step.check ? { check: { status: step.check.status, detail: step.check.detail ?? "" } } : {}),
    };
  });
  // A sequence written for different STEP bytes may still resolve by label; say so rather than guess.
  const stale = document.step !== undefined && document.step.sha256 !== model.source.sha256;
  // State arrives as fresh objects on every update; the digest lets the renderer key on content instead.
  const digest = createHash("sha256").update(JSON.stringify({ file, stale, steps })).digest("hex");
  return { file, stale, digest, steps };
}

export async function readSequence(stepPath, model, root) {
  let file = sequencePath(stepPath);
  try {
    file = await realpath(file);
    if (!isInside(root, file)) throw new PrototypeError("outside_project", "Assembly sequence must be inside the selected project root", 403);
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) throw new PrototypeError("invalid_sequence", "Assembly sequence file must be a JSON file under 1 MB", 422);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const relative = path.relative(root, file).split(path.sep).join("/");
  let document;
  try { document = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new PrototypeError("invalid_sequence", `Assembly sequence ${relative} is not valid JSON`, 422); }
  return resolveSequence(document, model, relative);
}
