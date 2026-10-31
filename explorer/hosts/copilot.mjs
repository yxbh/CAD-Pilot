import { access } from "node:fs/promises";
import path from "node:path";
import { createExplorerServer } from "../server/server.mjs";
import { inspectAcross } from "../server/inspection.mjs";
import { explorerRoot, userRuntimeRoot, workbenchRoot, workbenchRuntimeRoot } from "../server/paths.mjs";
import { createViewRegistry } from "../server/view-registry.mjs";
import { pushComposerAttachment } from "../server/composer.mjs";
import { COMMANDS, objectSchema } from "../shared/commands.mjs";

export async function startCopilotExplorer({ joinSession, createCanvas, CanvasError }, {
  createService = createExplorerServer,
  runtimeRoot = workbenchRuntimeRoot,
  inspect = inspectAcross([runtimeRoot, userRuntimeRoot()]),
  checkBuild = () => access(path.join(explorerRoot, "dist", "index.html")),
  canonicalize,
} = {}) {
  let session;
  const registry = createViewRegistry({
    canonicalize,
    createService: ({ firstPanel, ...input }) => createService({
      ...input, runtimeRoot,
      addReferenceToChat: (attachment) => {
        const instanceId = firstPanel();
        if (!instanceId) throw new CanvasError("not_open", "Open CAD Explorer before adding a reference");
        return pushComposerAttachment(session, attachment, instanceId);
      },
      log: (message) => {
        void session.log(message, { level: "warning" }).catch((error) => {
          process.stderr.write(`Explorer log delivery failed: ${error.message}\n${message}\n`);
        });
      },
    }),
  });
  const translated = async (operation) => {
    try { return await operation(); }
    catch (error) { throw new CanvasError(error?.code || "explorer_error", error instanceof Error ? error.message : String(error)); }
  };
  const action = ([name, { description, inputSchema, render }]) => ({
    name, description,
    inputSchema,
    handler: (ctx) => translated(async () => {
      const service = registry.serviceFor(ctx.instanceId);
      if (render === "capture") return service.captureImage(ctx.input || {});
      const result = await service.execute(name, ctx.input || {}, { rendered: render === "live" });
      // View actions answer with the compact summary; get_state detail=full is there for everything else.
      return name !== "get_state" && result?.application ? service.summary() : result;
    }),
  });
  const inspectionTool = (name) => ({
    name,
    description: "Resolve a cadproto:v2 reference to its exact cached STEP occurrence, CAD face or CAD edge and original placement. These are not the cad skill's @cad inspector ordinals.",
    parameters: objectSchema({ reference: { type: "string", maxLength: 16384 } }, ["reference"]),
    handler: async ({ reference }) => {
      try { return { textResultForLlm: JSON.stringify(await inspect(reference)), resultType: "success" }; }
      catch (error) { return { textResultForLlm: error.message, resultType: "failure" }; }
    },
  });
  session = await joinSession({
    tools: [inspectionTool("cad_explorer_inspect")],
    canvases: [createCanvas({
      id: "cad-explorer",
      displayName: "CAD Explorer",
      description: "Local STEP assemblies with exact face and edge references, visual section cutaways, exploded views, assembly steps, Studio appearance and saved drawing reviews.",
      inputSchema: objectSchema({
        projectRoot: { type: "string", description: "Authorized CAD project root; defaults to this workbench checkout." },
        file: { type: "string", description: "STEP path inside that root. Omit to restore this setup or load the demo." },
        viewId: { type: "string", minLength: 1, maxLength: 80, description: "Remembered setup identity, default 'default'. Reuse its existing panel rather than opening a linked copy." },
      }),
      actions: Object.entries(COMMANDS).filter(([, definition]) => definition.canvas).map(action),
      open: (ctx) => translated(async () => {
        try { await checkBuild(); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          throw new CanvasError("not_built", "Build CAD Explorer first: npm --prefix explorer run build");
        }
        const service = await registry.open(ctx.instanceId, { projectRoot: workbenchRoot, ...ctx.input });
        return { url: service.url, title: "CAD Explorer", status: "v1" };
      }),
      onClose: (ctx) => registry.close(ctx.instanceId),
    })],
  });
  return { session, shutdown: () => registry.shutdown() };
}
