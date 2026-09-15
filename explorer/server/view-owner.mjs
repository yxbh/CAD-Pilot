import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrototypeError } from "./protocol.mjs";

export async function acquireViewOwner(runtimeRoot, viewKey) {
  const identity = `${runtimeRoot}\n${viewKey}`;
  const key = createHash("sha256").update(process.platform === "win32" ? identity.toLowerCase() : identity).digest("hex");
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\cad-pilot-view-${key}`
    : path.join(tmpdir(), `cad-pilot-view-${key}.sock`);
  // This endpoint carries no data; its exclusive OS ownership prevents competing writers.
  const owner = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = (error) => {
      if (error.code === "EADDRINUSE" || (process.platform === "win32" && error.code === "EACCES")) {
        reject(new PrototypeError("view_in_use", "This saved view is already open in another Explorer process. Use that panel or choose a different viewId.", 409));
      } else reject(error);
    };
    owner.once("error", failed);
    owner.listen({ path: address, exclusive: true }, () => {
      owner.removeListener("error", failed);
      owner.unref();
      resolve();
    });
  });
  let closing;
  return () => closing ??= new Promise((resolve, reject) => owner.close((error) => error ? reject(error) : resolve()));
}
