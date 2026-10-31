// Links the user's Claude Code skills folder to this checkout's skills, so sessions started in any folder load them.
// Each <config>/skills/<name> becomes a link to .agents/skills/<name> (a junction on Windows, which needs no extra
// rights), so the checkout stays the only copy. A link to some checkout's .agents/skills/<name> is replaced; any
// other entry with a skill's name is left alone and reported.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length > 2) {
  console.error("Usage: node tools/install-skills.mjs\n  Links $CLAUDE_CONFIG_DIR/skills (default ~/.claude/skills) to this checkout's skills.");
  process.exit(2);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const skills = path.join(root, ".agents", "skills");
const folder = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills");
const names = readdirSync(skills, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(skills, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort();
// A linked worktree's .git is a file; its folder goes away with the worktree, and the links with it.
if (existsSync(path.join(root, ".git")) && statSync(path.join(root, ".git")).isFile()) {
  console.warn(`${root} is a linked worktree: run this from the main checkout again once you are done with it`);
}
// The skills folder, or the folder it links to, must be the user's own: a checkout's .agents/skills holds that
// checkout's skill folders and its .claude/skills its tracked relative links, and neither may be changed.
const real = existsSync(folder) ? realpathSync(folder) : folder;
const checkout = path.dirname(path.dirname(real));
if (path.basename(real) === "skills" && [".agents", ".claude"].includes(path.basename(path.dirname(real)))
    && existsSync(path.join(checkout, "tools", "install-skills.mjs"))) {
  const how = lstatSync(folder).isSymbolicLink() ? "remove that link (not the folder it points to)" : "set CLAUDE_CONFIG_DIR to your own Claude configuration folder";
  console.error(`${folder} is ${real}, a CAD-Pilot checkout's own skills folder; ${how} and run this again to link each skill instead`);
  process.exit(1);
}
mkdirSync(folder, { recursive: true });
const isSkillLink = (target, name) => {
  const parts = path.resolve(real, target).split(/[\\/]+/);
  return parts.slice(-3).join("/") === `.agents/skills/${name}`;
};
let refused = 0;
for (const name of names) {
  const target = path.join(skills, name);
  const link = path.join(folder, name);
  let previous = null;
  try {
    previous = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous !== null && !isSkillLink(previous, name)) {
    console.error(`${link} is not a link to a CAD-Pilot skill; move it aside and run this again`);
    refused += 1;
    continue;
  }
  if (previous !== null) unlinkSync(link);
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  const replaced = previous && path.resolve(folder, previous) !== path.resolve(target) ? ` (was ${previous})` : "";
  console.log(`${link} -> ${target}${replaced}`);
}
process.exitCode = refused ? 1 : 0;
