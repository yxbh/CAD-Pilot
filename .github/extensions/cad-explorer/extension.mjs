import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { startCopilotExplorer } from "../../../explorer/hosts/copilot.mjs";

const provider = await startCopilotExplorer({ joinSession, createCanvas, CanvasError });

process.once("SIGTERM", () => {
  void provider.shutdown().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`CAD Explorer shutdown failed: ${error.message}\n`);
      process.exit(1);
    },
  );
});
