import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("face and part modes preview hovered geometry without selecting it", { timeout: 240_000 }, () => checkBrowser("hover-browser.py"));
