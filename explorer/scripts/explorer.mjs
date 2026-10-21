import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../shared/commands.mjs";
import { createInspectionService } from "../server/inspection.mjs";
import { call, defaultViewId, locateView, openViewer, runningViewer, sendCommand, stopViewer } from "../server/launcher.mjs";
import { isInside, workbenchRoot } from "../server/paths.mjs";
import { PrototypeError } from "../server/protocol.mjs";

export const USAGE = `Usage: node <workbench>/explorer/scripts/explorer.mjs <command> [arguments] [--view <name>]
Run from the design project's root folder. Results are printed as JSON.

  open [file.step]      Start or reuse this project's viewer, load the STEP and print its URL
  state                 Print the viewer's model, camera, selection and section state
  actions               List the view actions accepted by "do"
  do <action> [input]   Run a view action. Give its input as key=value pairs, which survive any shell,
                        e.g. do set_section enabled=true axis=y position=10, or as one JSON object
  capture [out.png]     Save an image of the view; the viewer page must be open
  inspect <reference>   Resolve a copied cadproto:v2 reference (the viewer need not be running)
  stop                  Stop this project's viewer; its address and saved setup are kept

--view <name> selects an independent remembered setup (default "${defaultViewId}").`;

// Actions that need a Copilot chat composer or are owned by the page itself are not offered here.
const UNAVAILABLE = new Set(["add_reference_to_chat", "save_camera"]);
const actionNames = () => Object.keys(COMMANDS).filter((name) => COMMANDS[name].canvas && !UNAVAILABLE.has(name));

function parseArguments(argv) {
  const positional = [];
  let viewId = process.env.CAD_EXPLORER_VIEW || defaultViewId;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--view") {
      viewId = argv[++index];
      if (!viewId) throw new PrototypeError("bad_arguments", "--view needs a name");
    } else if (argv[index] === "--help" || argv[index] === "-h") positional.unshift("help");
    else positional.push(argv[index]);
  }
  return { command: positional[0] || "help", args: positional.slice(1), viewId };
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

// A capture copy must land in the project even when a folder on the way is a symlink, and never write through one.
async function projectOutput(project, out) {
  const target = path.resolve(project, out);
  if (!isInside(project, target) || path.extname(target).toLowerCase() !== ".png") throw new PrototypeError("bad_output", "Choose a .png path inside the project");
  let existing = path.dirname(target);
  while (!(await lstat(existing).catch(() => null))) existing = path.dirname(existing);
  if (!isInside(project, await realpath(existing))) throw new PrototypeError("bad_output", "Choose a .png path inside the project");
  return target;
}

async function saveCopy(project, source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const folder = await realpath(path.dirname(target));
  const current = await lstat(target).catch(() => null);
  if (!isInside(project, folder) || (current && !current.isFile())) throw new PrototypeError("bad_output", "Choose a .png path inside the project that is not a link or folder");
  await copyFile(source, path.join(folder, path.basename(target)));
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

function rendererHint(error, url) {
  if (["renderer_timeout", "capture_timeout"].includes(error?.code)) {
    error.message = `No open viewer page rendered the view. Open ${url} (for example in the Claude desktop browser pane), keep it open and retry.`;
  }
  return error;
}

export async function run(argv, { cwd = process.cwd(), inspect } = {}) {
  const { command, args, viewId } = parseArguments(argv);
  if (command === "help") return USAGE;
  if (command === "actions") {
    return actionNames().map((name) => {
      const { description, inputSchema } = COMMANDS[name];
      const { expectedRevision, ...input } = inputSchema.properties;
      return { name, description, input, required: inputSchema.required };
    });
  }
  if (command === "inspect") {
    if (!args.length) throw new PrototypeError("bad_arguments", "inspect needs a copied reference");
    const resolve = inspect ?? createInspectionService({ runtimeRoot: (await locateView({ projectRoot: cwd, viewId })).runtimeRoot, workbenchRoot }).inspectReference;
    return resolve(await referenceFrom(args.join(" ")));
  }
  const location = await locateView({ projectRoot: cwd, viewId });
  if (command === "open") return openViewer(location, args[0]);
  if (command === "stop") return stopViewer(location);
  const { record } = await viewer(location);
  if (command === "state") return call(record, "api/state");
  if (command === "capture" || (command === "do" && args[0] === "capture_image")) {
    const out = command === "capture" ? args[0] : undefined;
    const target = out && await projectOutput(location.project, out);
    const result = await call(record, "api/capture", {}).catch((error) => { throw rendererHint(error, record.url); });
    if (!target) return result;
    await saveCopy(location.project, result.path, target);
    return { ...result, saved: path.relative(location.project, target).split(path.sep).join("/") };
  }
  if (command === "do") {
    const [name, ...inputArgs] = args;
    if (!actionNames().includes(name)) throw new PrototypeError("unknown_action", `Unknown view action "${name ?? ""}". Run "actions" to list them.`);
    return sendCommand(record, name, actionInput(inputArgs)).catch((error) => { throw rendererHint(error, record.url); });
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
