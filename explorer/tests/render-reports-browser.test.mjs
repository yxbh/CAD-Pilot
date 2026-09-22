import test from "node:test";
import { runBrowser } from "./browser-fixture.mjs";
import { renderReportFixture } from "./render-report-fixture.mjs";

test("late renderer requests and failures stay scoped to the mounted model/view in a real browser", { timeout: 120_000 }, () =>
  renderReportFixture(async ({ service, root }) => {
    const result = await runBrowser("render-reports-browser.py", { url: service.url, output: root, timeout: 90_000 });
    console.log(result.stdout.trim());
  }));
