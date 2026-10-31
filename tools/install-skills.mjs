// Links the user's Claude Code skills folder to this checkout's skills, so sessions started in any folder load them.
// Each <config>/skills/<name> becomes a link to .agents/skills/<name> (a junction on Windows, which needs no extra
// rights), so the checkout stays the only copy. Earlier links are replaced; anything else is left alone.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length > 2) {
  console.error("Usage: node tools/install-skills.mjs\n  Links $CLAUDE_CONFIG_DIR/skills (default ~/.claude/skills) to this checkout's skills.");
  process.exit(2);
}
const skills = path.join(fileURLToPath(new URL("../", import.meta.url)), ".agents", "skills");
const folder = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills");
const names = readdirSync(skills, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(skills, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort();
mkdirSync(folder, { recursive: true });
let refused = 0;
for (const name of names) {
  const target = path.join(skills, name);
  const link = path.join(folder, name);
  let previous = null;
  try {
    if (!lstatSync(link).isSymbolicLink()) {
      console.error(`${link} is not a link; move it aside and run this again`);
      refused += 1;
      continue;
    }
    previous = readlinkSync(link);
    unlinkSync(link);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  const replaced = previous && path.resolve(folder, previous) !== path.resolve(target) ? ` (was ${previous})` : "";
  console.log(`${link} -> ${target}${replaced}`);
}
process.exitCode = refused ? 1 : 0;
