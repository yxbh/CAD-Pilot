import { createExplorerServer } from "./server.mjs";

const service = await createExplorerServer({
  projectRoot: process.cwd(),
  viewId: process.env.CAD_EXPLORER_VIEW || "standalone",
  file: process.argv[2],
});
process.stdout.write(`${service.url}\n`);
await service.initialize();
process.stdout.write(`Ready: ${service.getState().modelName || service.getState().error}\n`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void service.close().then(() => process.exit(0)); });
