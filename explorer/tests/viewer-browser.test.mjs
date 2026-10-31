import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("native reference clipboard, selection and manual-copy fallback", { timeout: 240_000 }, () => checkBrowser("browser_smoke.py"));
