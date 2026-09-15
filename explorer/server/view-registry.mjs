import path from "node:path";
import { canonicalProjectRoot } from "./paths.mjs";
import { PrototypeError } from "./protocol.mjs";

export function createViewRegistry({ createService, canonicalize = canonicalProjectRoot }) {
  const views = new Map();
  const panels = new Map();
  let stopping = false;
  let stopped;
  const keyFor = (projectRoot, viewId) => JSON.stringify([process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot, viewId]);
  const validateViewId = (viewId) => {
    if (typeof viewId !== "string" || !viewId.length || viewId.length > 80) throw new PrototypeError("bad_view_id", "viewId must contain 1 to 80 characters");
  };
  const enqueue = (entry, action) => {
    const next = entry.operations.then(action, action);
    entry.operations = next;
    return next;
  };
  const closeEntry = (entry) => {
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      await entry.ready;
      await entry.operations.catch(() => undefined);
      await entry.service.close();
      if (views.get(entry.key) === entry) views.delete(entry.key);
    })();
    return entry.closing;
  };

  async function open(instanceId, { projectRoot, viewId = "default", file } = {}) {
    validateViewId(viewId);
    const project = await canonicalize(projectRoot);
    const key = keyFor(project, viewId);
    if (stopping) throw new PrototypeError("closed", "Explorer is stopping", 410);
    const existing = panels.get(instanceId);
    if (existing) {
      if (existing.closing) { await existing.closing; return open(instanceId, { projectRoot: project, viewId, file }); }
      if (existing.key !== key) throw new PrototypeError("panel_in_use", "This panel already belongs to another saved view");
      return existing.ready;
    }
    let entry = views.get(key);
    if (entry?.closing) { await entry.closing; return open(instanceId, { projectRoot: project, viewId, file }); }
    if (entry?.panels.size) {
      throw new PrototypeError("view_already_open", `This setup is already open in panel "${entry.panels.values().next().value}". Use the existing tab, or choose a different viewId for an independent setup.`, 409);
    }
    let initializing = !!entry && !entry.initialized;
    if (!entry) {
      entry = {
        key, projectRoot: project, viewId, initialFile: file ? path.resolve(project, file) : null,
        initialized: false, service: null, panels: new Set(), operations: Promise.resolve(), ready: null, closing: null,
      };
      const created = entry;
      views.set(key, created);
      created.ready = (async () => {
        try {
          created.service = await createService({
            projectRoot: project, viewId, file,
            firstPanel: () => created.panels.values().next().value,
          });
          await created.service.initialize();
          created.initialized = true;
          return created;
        } catch (error) {
          try { await created.service?.close(); }
          finally { if (views.get(key) === created) views.delete(key); }
          throw error;
        }
      })();
      initializing = true;
    }
    const slot = { key, entry, ready: null, closing: null };
    panels.set(instanceId, slot);
    entry.panels.add(instanceId);
    slot.ready = (async () => {
      try {
        await entry.ready;
        if (stopping) throw new PrototypeError("closed", "Explorer is stopping", 410);
        if (file && !(initializing && entry.initialFile === path.resolve(project, file))) {
          await enqueue(entry, () => entry.service.execute("load_file", { file }));
        }
        return entry.service;
      } catch (error) {
        if (panels.get(instanceId) === slot) panels.delete(instanceId);
        entry.panels.delete(instanceId);
        if (entry.initialized && !entry.panels.size) await closeEntry(entry);
        throw error;
      }
    })();
    return slot.ready;
  }

  async function close(instanceId) {
    const slot = panels.get(instanceId);
    if (!slot) return;
    if (slot.closing) return slot.closing;
    slot.closing = (async () => {
      try { await slot.ready; }
      finally {
        if (panels.get(instanceId) === slot) panels.delete(instanceId);
        slot.entry.panels.delete(instanceId);
        if (slot.entry.initialized && !slot.entry.panels.size) await closeEntry(slot.entry);
      }
    })();
    return slot.closing;
  }

  return {
    open, close,
    serviceFor(instanceId) {
      const slot = panels.get(instanceId);
      if (!slot || slot.closing || !slot.entry.initialized || stopping) throw new PrototypeError("not_open", "Open the CAD Explorer canvas first", 409);
      return slot.entry.service;
    },
    shutdown() {
      if (stopped) return stopped;
      stopping = true;
      stopped = (async () => {
        const results = await Promise.allSettled([...panels.keys()].map(close));
        const remaining = await Promise.allSettled([...views.values()].map(closeEntry));
        const failures = [...results, ...remaining].filter((result) => result.status === "rejected")
          .map((result) => result.reason).filter((error) => !(error instanceof PrototypeError && error.code === "closed"));
        if (failures.length) throw new AggregateError(failures, "Explorer services did not all close cleanly");
      })();
      return stopped;
    },
  };
}
