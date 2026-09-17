import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeRoot, workbenchRoot } from "../server/paths.mjs";
import { atomicJson } from "../server/storage.mjs";
import { acquireViewOwner } from "../server/view-owner.mjs";

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function requireAbsent(file) {
  try { await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error(`Destination already exists; refusing to merge or overwrite: ${file}`);
}

async function inventory(root, relative = "") {
  const records = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      records.push({ name, directory: true }, ...await inventory(root, name));
    } else if (entry.isFile()) {
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(path.join(root, name))) hash.update(bytes);
      records.push({ name, sha256: hash.digest("hex") });
    } else {
      throw new Error(`Runtime contains a symlink or special file; relocation refused: ${name}`);
    }
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

function readObject(text, file) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid runtime metadata: ${file}`);
  return value;
}

export async function relocateRuntime({ source, destination = runtimeRoot, workbench = workbenchRoot }) {
  workbench = await realpath(workbench);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Source must be a real runtime directory.");
  source = await realpath(source);
  destination = path.join(await realpath(path.dirname(destination)), path.basename(destination));
  if (path.basename(source) !== ".runtime" || path.basename(destination) !== ".runtime" ||
      !inside(workbench, source) || !inside(workbench, destination) ||
      source === destination || inside(source, destination) || inside(destination, source)) {
    throw new Error("Choose distinct, non-nested .runtime directories inside this workbench.");
  }
  await requireAbsent(destination);
  const before = await inventory(source);
  const releases = [];
  let temporary;
  try {
    const viewKeys = new Set(before.flatMap(({ name }) => {
      const [folder, entry] = name.split(path.sep);
      if (folder === "views" && /^[a-f0-9]{24}\.json$/.test(entry)) return [entry.slice(0, -5)];
      if (folder === "reviews" && /^[a-f0-9]{24}$/.test(entry)) return [entry];
      return [];
    }));
    for (const key of [...viewKeys].sort()) {
      releases.push(await acquireViewOwner(source, key));
      releases.push(await acquireViewOwner(destination, key));
    }
    const rebase = (file) => inside(source, file) ? path.join(destination, path.relative(source, file)) : file;
    const updates = [];
    for (const { name, directory } of before) {
      const [folder] = name.split(path.sep);
      if (directory || !name.endsWith(".json") || !["views", "references"].includes(folder)) continue;
      const value = readObject(await readFile(path.join(source, name), "utf8"), name);
      if (folder === "views" && value.inputFile) {
        if (typeof value.inputFile !== "string" || !path.isAbsolute(value.inputFile)) throw new Error(`Invalid inputFile in ${name}`);
        value.inputFile = rebase(value.inputFile);
      }
      if (folder === "references") {
        if (value.workbenchRelativeSnapshot != null) {
          if (typeof value.workbenchRelativeSnapshot !== "string" || path.isAbsolute(value.workbenchRelativeSnapshot)) {
            throw new Error(`Invalid workbenchRelativeSnapshot in ${name}`);
          }
          value.workbenchRelativeSnapshot = path.relative(workbench, rebase(path.resolve(workbench, value.workbenchRelativeSnapshot)));
        }
        value.inspectionTool = "cad_explorer_inspect";
      }
      updates.push({ name, value });
    }
    await mkdir(path.join(workbench, ".local"), { recursive: true });
    temporary = await mkdtemp(path.join(workbench, ".local", "runtime-relocation-"));
    const staged = path.join(temporary, ".runtime");
    await cp(source, staged, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    if (JSON.stringify(await inventory(staged)) !== JSON.stringify(before) ||
        JSON.stringify(await inventory(source)) !== JSON.stringify(before)) {
      throw new Error("Runtime changed during relocation; source left in place. Close all Explorer processes and retry.");
    }
    for (const { name, value } of updates) await atomicJson(path.join(staged, name), value);
    await requireAbsent(destination);
    await rename(staged, destination);
    // The complete, verified destination exists before the source is removed.
    await rm(source, { recursive: true });
    return { source, destination, files: before.filter((entry) => !entry.directory).length, updatedMetadata: updates.length };
  } finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    finally { await Promise.all(releases.map((release) => release())); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node explorer/scripts/relocate-runtime.mjs <source-.runtime-directory>\nStop all Explorer processes for this checkout first. The destination must not exist.");
    const result = await relocateRuntime({ source: path.resolve(process.argv[2]) });
    console.log(`Moved ${result.files} files to ${result.destination}. Copy file references again from the viewer.`);
  } catch (error) {
    console.error(`Runtime relocation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
