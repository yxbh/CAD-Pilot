import { randomUUID } from "node:crypto";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { replaceFile } from "./storage.mjs";

// One record per standalone setup keeps its loopback address (including the capability token) so links survive
// relaunches and a second launcher can find the running viewer. It is private local data, like the rest of the runtime.
export const endpointFile = (runtimeRoot, viewKey) => path.join(runtimeRoot, "views", `${viewKey}.endpoint.json`);

export function validEndpoint(record) {
  return !!record && typeof record === "object" && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535
    && typeof record.token === "string" && /^[a-f0-9]{48}$/.test(record.token) && Number.isInteger(record.pid)
    && record.url === `http://127.0.0.1:${record.port}/${record.token}/`;
}

export async function readEndpoint(file) {
  let record;
  try { record = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  return validEndpoint(record) ? record : null;
}

export async function writeEndpoint(file, record) {
  if (!validEndpoint(record)) throw new Error("Invalid Explorer endpoint record");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  try {
    await chmod(temporary, 0o600);
    await replaceFile(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

// Proves the record's server is a live Explorer holding that token, not just any process on the port.
export async function probeEndpoint(record, { timeout = 2000 } = {}) {
  if (!validEndpoint(record)) return null;
  try {
    const response = await fetch(`${record.url}api/state`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return null;
    const state = await response.json();
    return state?.application === "CAD Explorer" ? state : null;
  } catch { return null; }
}
