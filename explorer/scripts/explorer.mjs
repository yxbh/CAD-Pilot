import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../shared/commands.mjs";
import { createInspectionService } from "../server/inspection.mjs";
import { call, defaultViewId, locateView, openViewer, runningViewer, sendCommand, stopViewer } from "../server/launcher.mjs";
import { workbenchRoot, workbenchRuntimeRoot } from "../server/paths.mjs";
import { PrototypeError } from "../server/protocol.mjs";
import { projectOutput, renderOnce, saveCopy } from "../server/render-once.mjs";
import { pruneRuntime } from "../server/runtime-store.mjs";
import { revisionLabel } from "../server/summary.mjs";

export const USAGE = `Usage: node <workbench>/explorer/scripts/explorer.mjs <command> [arguments] [--view <name>]
Run from the design project's root folder. Results are printed as JSON.

  open [file.step]      Start or reuse this project's viewer, load the STEP, confirm it was drawn and print its URL
  state [--full]        Summarize the shown model (file, revision, generated time) and view; --full adds every detail
  actions               List the view actions accepted by "do"
  do <action> [input]   Run a view action. Give its input as key=value pairs, which survive any shell,
                        e.g. do set_section enabled=true axis=y position=10, or as one JSON object. --full as for state
  capture [out.png]     Save an image of the current view, drawn in the background; no viewer page needs to be open.
                        --size 1600x1000 and --background "#ffffff" change this image only
  render <file.step> <out.png>
                        Render a STEP to a PNG without opening or changing a viewer: --size WxH, --view iso|top|...|AZ:EL,
                        --projection, --appearance inspect|studio, --finish, --outlines on|off, --background "#rrggbb",
                        --section x[:position][:flipped], --explode amount[:direction], --step N[:buildup], --hide "label,label"
  inspect <reference>   Resolve a copied cadproto:v2 reference (the viewer need not be running)
  prune [--dry-run] [--all] [--copilot]
                        Remove old snapshots, model caches and captures that no saved setup shows (--all: regardless
                        of age; --copilot: the Copilot canvas's store in this workbench instead of the user's)
  stop                  Stop this project's viewer; its address and saved setup are kept

--view <name> selects an independent remembered setup (default "${defaultViewId}").`;

// Actions that need a Copilot chat composer or are owned by the page itself are not offered here.
const UNAVAILABLE = new Set(["add_reference_to_chat", "save_camera"]);
const actionNames = () => Object.keys(COMMANDS).filter((name) => COMMANDS[name].canvas && !UNAVAILABLE.has(name));
const valued = new Set(["--view", "--size", "--background", "--projection", "--appearance", "--finish", "--outlines", "--section", "--explode", "--step", "--hide"]);
const switches = new Set(["--full", "--dry-run", "--all", "--copilot"]);

function parseArguments(argv) {
  const positional = [];
  const flags = {};
  let view;
  let command;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") command = "help";
    else if (switches.has(argument)) flags[argument.slice(2)] = true;
    else if (valued.has(argument)) {
      const value = argv[++index];
      if (value === undefined) throw new PrototypeError("bad_arguments", `${argument} needs a value`);
      if (argument === "--view") view = value;
      else flags[argument.slice(2)] = value;
    } else positional.push(argument);
  }
  command ||= positional[0] || "help";
  // --view names a remembered setup everywhere except render, which saves no setup and uses it for the camera.
  if (command === "render") flags.view = view;
  const viewId = command !== "render" && view !== undefined ? view : process.env.CAD_EXPLORER_VIEW || defaultViewId;
  return { command, args: positional.slice(1), viewId, flags };
}

// key=value pairs avoid shell-specific JSON quoting (Windows PowerShell strips embedded quotes). Values that parse
// as JSON (numbers, booleans, arrays) keep that type; anything else is a string.
export function actionInput(args) {
  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try { return JSON.parse(args[0]); }
    catch { throw new PrototypeError("bad_arguments", "Action input must be key=value pairs or one JSON object"); }
  }
  const input = {};
  for (const pair of args) {
    const split = pair.indexOf("=");
    if (split < 1) throw new PrototypeError("bad_arguments", `Expected key=value, got "${pair}"`);
    const value = pair.slice(split + 1);
    try { input[pair.slice(0, split)] = JSON.parse(value); }
    catch { input[pair.slice(0, split)] = value; }
  }
  return input;
}

const number = (text, flag) => {
  const value = Number(text);
  if (text === "" || !Number.isFinite(value)) throw new PrototypeError("bad_arguments", `${flag} needs a number, got "${text}"`);
  return value;
};

function imageSize(text) {
  if (text === undefined) return {};
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!match) throw new PrototypeError("bad_arguments", `--size takes WIDTHxHEIGHT in pixels, such as 1600x1000; got "${text}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

// Render flags are a shell-friendly spelling of the same view actions `do` runs.
export function renderOptions(flags) {
  const options = { ...imageSize(flags.size), background: flags.background, view: flags.view, projection: flags.projection, appearance: flags.appearance, finish: flags.finish };
  if (flags.outlines !== undefined) {
    if (!["on", "off"].includes(flags.outlines)) throw new PrototypeError("bad_arguments", "--outlines takes on or off");
    options.outlines = flags.outlines === "on";
  }
  if (flags.section !== undefined) {
    const [axis, ...rest] = flags.section.split(":");
    options.section = { axis, flipped: rest.includes("flipped") };
    const position = rest.find((part) => part !== "flipped");
    if (position !== undefined) options.section.position = number(position, "--section");
  }
  if (flags.explode !== undefined) {
    const [amount, direction] = flags.explode.split(":");
    options.explode = { amount: number(amount, "--explode"), ...(direction ? { direction } : {}) };
  }
  if (flags.step !== undefined) {
    const [step, mode] = flags.step.split(":");
    options.step = { step: number(step, "--step"), ...(mode ? { mode } : {}) };
  }
  if (flags.hide !== undefined) options.hide = flags.hide.split(",").map((label) => label.trim()).filter(Boolean);
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

// Accepts the pasted text (summary line plus address), a bare address, a descriptor JSON path or Copilot chip markup.
export async function referenceFrom(text) {
  const address = /cadproto:v2:[^\s`"'<>]+/.exec(text)?.[0];
  if (address) return address;
  const chip = /target-id="([^"]+)"/.exec(text)?.[1];
  const descriptor = chip ? chip.replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&") : text.trim();
  let parsed;
  try { parsed = JSON.parse(await readFile(descriptor, "utf8")); }
  catch { throw new PrototypeError("bad_reference", "Supply a copied cadproto:v2 reference or its descriptor JSON path"); }
  if (typeof parsed?.reference !== "string") throw new PrototypeError("bad_reference", "The descriptor does not contain a cadproto:v2 reference");
  return parsed.reference;
}

async function viewer(location) {
  const running = await runningViewer(location);
  if (!running) throw new PrototypeError("not_running", "No Explorer viewer is running for this project. Run: explorer.mjs open <file.step>", 409);
  return running;
}

const megabytes = (bytes) => Math.round(bytes / 1048576 * 10) / 10;

export async function run(argv, { cwd = process.cwd(), inspect } = {}) {
  const { command, args, viewId, flags } = parseArguments(argv);
  if (command === "help") return USAGE;
  if (command === "actions") {
    return actionNames().map((name) => {
      const { description, inputSchema } = COMMANDS[name];
      const { expectedRevision, ...input } = inputSchema.properties;
      return { name, description, input, required: inputSchema.required };
    });
  }
  const location = await locateView({ projectRoot: cwd, viewId });
  if (command === "inspect") {
    if (!args.length) throw new PrototypeError("bad_arguments", "inspect needs a copied reference");
    const resolve = inspect ?? createInspectionService({ runtimeRoot: location.runtimeRoot, workbenchRoot }).inspectReference;
    return resolve(await referenceFrom(args.join(" ")));
  }
  if (command === "prune") {
    const result = await pruneRuntime(flags.copilot ? workbenchRuntimeRoot : location.runtimeRoot, { dryRun: !!flags["dry-run"], all: !!flags.all });
    return { ...result, freedMB: megabytes(result.freedBytes), keptMB: megabytes(result.keptBytes) };
  }
  if (command === "render") {
    if (args.length !== 2) throw new PrototypeError("bad_arguments", "render needs a STEP file and a .png output inside the project");
    return renderOnce({ project: location.project, file: args[0], output: args[1], runtimeRoot: location.runtimeRoot, options: renderOptions(flags) });
  }
  if (command === "open") return openViewer(location, args[0]);
  if (command === "stop") return stopViewer(location);
  const { record } = await viewer(location);
  const detail = flags.full ? "full" : "summary";
  if (command === "state") return call(record, `api/state?detail=${detail}`);
  if (command === "capture" || (command === "do" && args[0] === "capture_image")) {
    const out = command === "capture" ? args[0] : undefined;
    const target = out && await projectOutput(location.project, out);
    const input = command === "capture" ? { ...imageSize(flags.size), background: flags.background } : actionInput(args.slice(1));
    const result = await call(record, "api/capture", input);
    const saved = target ? { saved: await saveCopy(location.project, result.path, target) } : {};
    if (flags.full) return { ...result, ...saved };
    return {
      path: result.path, ...saved, width: result.width, height: result.height, model: result.modelName,
      revision: revisionLabel(result.documentRevision), viewRevision: result.revision,
    };
  }
  if (command === "do") {
    const [name, ...inputArgs] = args;
    if (!actionNames().includes(name)) throw new PrototypeError("unknown_action", `Unknown view action "${name ?? ""}". Run "actions" to list them.`);
    const input = actionInput(inputArgs);
    if (name === "get_state") return call(record, `api/state?detail=${input.detail ?? detail}`);
    return sendCommand(record, name, input, { detail });
  }
  throw new PrototypeError("bad_arguments", `Unknown command "${command}"\n\n${USAGE}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`);
    // A viewer that started but could not load the model still reports its URL; the exit status flags the error.
    if (result?.error) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
