import { access } from "node:fs/promises";
import path from "node:path";
import { createExplorerServer, inspectReference } from "../server/server.mjs";
import { explorerRoot, workbenchRoot } from "../server/paths.mjs";
import { createViewRegistry } from "../server/view-registry.mjs";
import { pushComposerAttachment } from "../server/composer.mjs";
import { MATERIAL_FINISHES, PROJECTIONS, VIEW_PRESETS } from "../shared/view-settings.mjs";

const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const ids = { type: "array", items: { type: "string" }, maxItems: 500 };
const revision = { type: "integer", minimum: 0 };

export async function startCopilotExplorer({ joinSession, createCanvas, CanvasError }, {
  createService = createExplorerServer,
  inspect = inspectReference,
  checkBuild = () => access(path.join(explorerRoot, "dist", "index.html")),
  canonicalize,
} = {}) {
  let session;
  const registry = createViewRegistry({
    canonicalize,
    createService: ({ firstPanel, ...input }) => createService({
      ...input,
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
  const action = (name, description, properties = {}, required = []) => ({
    name, description,
    inputSchema: objectSchema({ ...properties, expectedRevision: revision }, required),
    handler: (ctx) => translated(async () => {
      const service = registry.serviceFor(ctx.instanceId);
      if (name === "capture_image") return service.captureImage();
      return service.execute(name, ctx.input || {}, {
        rendered: !["get_state", "inspect_reference", "prepare_clipboard_reference", "list_reviews", "get_review", "open_review", "close_review"].includes(name),
      });
    }),
  });
  const inspectionTool = (name) => ({
    name,
    description: "Resolve a cadproto:v2 reference to its exact cached STEP occurrence or CAD face and original placement. These are not imported @cad inspector ordinals.",
    parameters: objectSchema({ reference: { type: "string", maxLength: 16384 } }, ["reference"]),
    handler: async ({ reference }) => {
      try { return { textResultForLlm: JSON.stringify(await inspect(reference)), resultType: "success" }; }
      catch (error) { return { textResultForLlm: error.message, resultType: "failure" }; }
    },
  });
  session = await joinSession({
    tools: [inspectionTool("cad_explorer_inspect"), inspectionTool("cad_explorer_prototype_inspect")],
    canvases: [createCanvas({
      id: "cad-explorer",
      displayName: "CAD Explorer",
      description: "Local STEP assemblies with exact face references, exploded views, Studio appearance and saved drawing reviews.",
      inputSchema: objectSchema({
        projectRoot: { type: "string", description: "Authorized CAD project root; defaults to this workbench checkout." },
        file: { type: "string", description: "STEP path inside that root. Omit to restore this setup or load the demo." },
        viewId: { type: "string", minLength: 1, maxLength: 80, description: "Remembered setup identity, default 'default'. Reuse its existing panel rather than opening a linked copy." },
      }),
      actions: [
        action("get_state", "Read the model, camera, selections, saved setup and actual renderer acknowledgement."),
        action("set_explode", "Separate parts visually without moving the camera or changing the STEP. Fit assembly separately if needed.", {
          amount: { type: "number", minimum: 0, maximum: 1 },
          fixedId: { type: "string", description: "Occurrence to keep fixed, or empty to clear." },
          direction: { enum: ["radial", "x", "y", "z"] },
        }),
        action("select_parts", "Highlight occurrences without writing the clipboard.", { ids }, ["ids"]),
        action("select_face", "Highlight a CAD face on the exact displayed topology, without writing the clipboard.", {
          id: { type: "string" }, faceId: { type: "string" }, topologyRevision: { type: "string" },
        }, ["id", "faceId", "topologyRevision"]),
        action("set_selection_mode", "Choose face or whole-part picking.", { mode: { enum: ["face", "part"] } }, ["mode"]),
        action("set_auto_copy", "Enable clipboard copying for future user selections. Selection never inserts or sends a chat message.", { enabled: { type: "boolean" } }, ["enabled"]),
        action("prepare_clipboard_reference", "Prepare a local exact-selection descriptor and native file-reference markup. Does not alter clipboard or chat.", { reference: { type: "string", maxLength: 16384 } }, ["reference"]),
        action("inspect_reference", "Resolve a copied cadproto reference from the retained exact cache.", { reference: { type: "string", maxLength: 16384 } }, ["reference"]),
        action("add_reference_to_chat", "Explicit alternative: add the current selection as a draft attachment without sending it. This is not the user-click clipboard workflow.", {}, ["expectedRevision"]),
        action("set_visibility", "Show or hide occurrences without moving the camera.", { ids, visible: { type: "boolean" } }, ["ids", "visible"]),
        action("isolate", "Show only one occurrence and fit it.", { id: { type: "string" } }, ["id"]),
        action("show_all", "Show all occurrences and fit the visible assembly."),
        action("set_view", "Fit an isometric or exact axis view: right +X, left -X, back +Y, front -Y, top +Z, bottom -Z.", { preset: { enum: VIEW_PRESETS } }, ["preset"]),
        action("set_projection", "Switch perspective or orthographic projection while retaining viewing direction and target-plane scale.", { projection: { enum: PROJECTIONS } }, ["projection"]),
        action("set_appearance", "Choose Inspect or Studio and a visual finish. Source CAD colors and geometry stay unchanged.", {
          mode: { enum: ["inspect", "studio"] }, finish: { enum: MATERIAL_FINISHES }, showEdges: { type: "boolean" },
        }),
        action("fit_view", "Explicitly frame visible parts, including their exploded positions."),
        action("reset_view", "Reassemble without moving the camera or changing STEP geometry."),
        action("load_file", "Load a STEP snapshot inside the configured project root.", { file: { type: "string" } }, ["file"]),
        action("load_demo", "Load the synthetic demonstration assembly."),
        action("capture_image", "Save an image of the settled live view or annotated drawing, with source and pose metadata."),
        action("list_reviews", "List saved drawing review summaries."),
        action("get_review", "Read a review's source, captured pose and mark count without image bytes.", { id: { type: "string" } }, ["id"]),
        action("open_review", "Open a saved drawing review; its captured camera and model pose do not move.", { id: { type: "string" } }, ["id"]),
        action("close_review", "Return to the live model."),
      ],
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
