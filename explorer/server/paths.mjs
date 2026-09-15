import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpath, stat } from "node:fs/promises";

export const explorerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const workbenchRoot = path.dirname(explorerRoot);
export const legacyPrototypeRoot = path.join(workbenchRoot, ".github", "extensions", "cad-explorer-prototype");
// Pasted file chips contain absolute descriptor paths in this retained directory.
export const runtimeRoot = path.join(legacyPrototypeRoot, ".runtime");

export async function canonicalProjectRoot(root) {
  const project = await realpath(root);
  if (!(await stat(project)).isDirectory()) throw new Error("Project root must be a directory");
  return project;
}
