import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("maintained drawing UI recovers conflicts, unconfirmed writes, local exports, and queued switching", { timeout: 240_000 }, () => checkBrowser("review-recovery-browser.py"));
