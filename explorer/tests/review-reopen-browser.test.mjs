import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("reopening after reload suspends live rendering throughout pending review reads and commands", { timeout: 240_000 }, () => checkBrowser("review-reopen-browser.py"));
