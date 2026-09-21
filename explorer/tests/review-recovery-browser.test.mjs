import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("maintained drawing UI recovers conflicts, unconfirmed writes, local exports, and queued switching", { timeout: 240_000 }, () => checkBrowser("review-recovery-browser.py"));
test("all drawing tools, PNG clipboard equivalence, fixed viewport, resize, and reload remain usable", { timeout: 240_000 }, () => checkBrowser("v2_browser.py"));
test("reopening after reload suspends live rendering throughout pending review reads and commands", { timeout: 240_000 }, () => checkBrowser("review-reopen-browser.py"));
test("face and part modes preview hovered geometry without selecting it", { timeout: 240_000 }, () => checkBrowser("hover-browser.py"));
