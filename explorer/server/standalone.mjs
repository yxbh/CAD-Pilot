import { createExplorerServer } from "./server.mjs";
import { readEndpoint, writeEndpoint } from "./endpoint.mjs";
import { assertBuilt, defaultViewId, launcherRuntimeRoot, locateView, reloadInto, waitForLoad, waitForViewer } from "./launcher.mjs";

const file = process.argv[2];
const print = (line) => process.stdout.write(`${line}\n`);

try {
  await assertBuilt();
  const location = await locateView({ projectRoot: process.cwd(), viewId: process.env.CAD_EXPLORER_VIEW || defaultViewId, runtimeRoot: launcherRuntimeRoot() });
  // Reuse the setup's previous address when possible so earlier links keep working.
  const previous = await readEndpoint(location.endpoint);
  let service;
  let stopping;
  const stop = () => stopping ??= service.close().then(() => process.exit(0), (error) => {
    process.stderr.write(`CAD Explorer shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
  try {
    service = await createExplorerServer({
      projectRoot: location.project, viewId: location.viewId, file, runtimeRoot: location.runtimeRoot,
      referenceFormat: "text", port: previous?.port, token: previous?.token, onShutdown: () => void stop(),
    });
  } catch (error) {
    if (error?.code !== "view_in_use") throw error;
    // Running the command again hands over to the live viewer instead of starting a competing one. A viewer
    // that is still starting may not have published its address yet.
    const running = await waitForViewer(location);
    if (!running) throw new Error("Another Explorer process holds this project's viewer but is not answering. Stop that process, or set CAD_EXPLORER_VIEW to open a separate setup.");
    const state = file ? await reloadInto(running.record, file) : await waitForLoad(running.record);
    print(running.record.url);
    print(`${file ? "Reloaded" : "Already running"}: ${state.modelName || state.error}`);
    process.exit(0);
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stop());
  const url = new URL(service.url);
  await writeEndpoint(location.endpoint, {
    url: service.url, port: Number(url.port), token: url.pathname.split("/")[1], pid: process.pid,
    projectRoot: location.project, viewId: location.viewId,
  });
  print(service.url);
  await service.initialize();
  print(`Ready: ${service.getState().modelName || service.getState().error}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
