import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("drawing transitions retain layout and report genuine context loss", { timeout: 240_000 }, () => checkBrowser("draw_transition.py"));
