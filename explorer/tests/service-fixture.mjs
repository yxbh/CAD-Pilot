import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExplorerServer } from "../server/server.mjs";

export function viewStateFile(runtimeRoot, projectRoot, viewId) {
  const key = createHash("sha256").update(`${projectRoot}\n${viewId}`).digest("hex").slice(0, 24);
  return path.join(runtimeRoot, "views", `${key}.json`);
}

export async function createTestRuntime(t) {
  const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-test-")));
  const services = new Set();
  const dispose = async () => {
    const results = await Promise.allSettled([...services].map((service) => service.close()));
    await rm(runtimeRoot, { recursive: true, force: true });
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Test services failed to close");
  };
  t?.after(dispose);
  return {
    runtimeRoot,
    async createService(options) {
      const service = await createExplorerServer({ ...options, runtimeRoot });
      services.add(service);
      return service;
    },
    dispose,
  };
}
