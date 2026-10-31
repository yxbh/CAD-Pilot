import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpath, stat } from "node:fs/promises";

export const explorerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const workbenchRoot = path.dirname(explorerRoot);

export function workbenchPythonPath(root, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32"
    ? paths.join(root, ".venv", "Scripts", "python.exe")
    : paths.join(root, ".venv", "bin", "python");
}

export const workbenchPython = workbenchPythonPath(workbenchRoot);

// The design-project viewer keeps copies of design geometry in the user's local application data, outside both the
// workbench checkout and the design project (which may be synced or published). CAD_EXPLORER_RUNTIME_ROOT overrides it.
export function userRuntimeRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.CAD_EXPLORER_RUNTIME_ROOT) return path.resolve(env.CAD_EXPLORER_RUNTIME_ROOT);
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "CAD-Pilot", "Explorer");
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "CAD-Pilot", "Explorer");
  return path.posix.join(env.XDG_STATE_HOME || path.posix.join(home, ".local", "state"), "cad-pilot", "explorer");
}

export const runtimeRoot = userRuntimeRoot();
// The Copilot canvas keeps its store in the checkout, where its native file-reference chips point inside the workspace.
// Kept outside .github/extensions: the Copilot app's repository-trust check counts every file there, including ignored data.
export const workbenchRuntimeRoot = path.join(explorerRoot, ".runtime");

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function canonicalProjectRoot(root) {
  const project = await realpath(root);
  if (!(await stat(project)).isDirectory()) throw new Error("Project root must be a directory");
  return project;
}
