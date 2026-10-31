import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("all drawing tools, PNG clipboard equivalence, fixed viewport, resize, and reload remain usable", { timeout: 240_000 }, () => checkBrowser("v2_browser.py"));
