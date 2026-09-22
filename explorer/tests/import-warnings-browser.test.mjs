import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("import warning details are dismissible without blocking explosion controls", { timeout: 240_000 },
  () => checkBrowser("import-warnings-browser.py"));
