import { connect, createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { link, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrototypeError } from "./protocol.mjs";

const unixSocketPathLimit = 100;
const maxListenAttempts = 3;

export function viewOwnerAddress(key, platform = process.platform, temporaryRoot = tmpdir()) {
  if (platform === "win32") return `\\\\.\\pipe\\cad-pilot-view-${key}`;
  const name = `cad-pilot-view-${key}.sock`;
  const candidate = path.posix.join(temporaryRoot, name);
  return Buffer.byteLength(candidate) <= unixSocketPathLimit ? candidate : path.posix.join("/tmp", name);
}

function listen(address) {
  // This endpoint carries no data; its exclusive OS ownership prevents competing writers.
  const owner = createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.listen({ path: address, exclusive: true }, () => {
      owner.removeListener("error", reject);
      owner.unref();
      resolve(owner);
    });
  });
}

// Anything other than a refused or missing endpoint is treated as a possible live owner.
function ownerMayBeLive(address) {
  return new Promise((resolve) => {
    const socket = connect(address);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => resolve(!["ECONNREFUSED", "ENOENT"].includes(error.code)));
  });
}

// A Unix socket file outlives an owner that terminated without closing it. Move the endpoint aside
// atomically and recheck it before deleting, so a concurrent claimant never deletes a live owner's endpoint.
export async function reclaimStaleEndpoint(address, { isLive = ownerMayBeLive } = {}) {
  if (await isLive(address)) return false;
  const claimed = path.join(path.dirname(address), `cad-pilot-stale-${randomBytes(8).toString("hex")}.sock`);
  try { await rename(address, claimed); }
  catch (error) { return error.code === "ENOENT"; }
  if (await isLive(claimed)) {
    await link(claimed, address).catch(() => {});
    await unlink(claimed).catch(() => {});
    return false;
  }
  await unlink(claimed);
  return true;
}

export async function acquireViewOwner(runtimeRoot, viewKey) {
  const identity = `${runtimeRoot}\n${viewKey}`;
  const key = createHash("sha256").update(process.platform === "win32" ? identity.toLowerCase() : identity).digest("hex");
  const address = viewOwnerAddress(key);
  let owner;
  for (let attempt = 1; !owner; attempt++) {
    try { owner = await listen(address); }
    catch (error) {
      if (error.code !== "EADDRINUSE" && !(process.platform === "win32" && error.code === "EACCES")) throw error;
      if (process.platform === "win32" || attempt === maxListenAttempts || !(await reclaimStaleEndpoint(address))) {
        throw new PrototypeError("view_in_use", "This saved view is already open in another Explorer process. Use that panel or choose a different viewId.", 409);
      }
    }
  }
  let closing;
  return () => closing ??= new Promise((resolve, reject) => owner.close((error) => error ? reject(error) : resolve()));
}
