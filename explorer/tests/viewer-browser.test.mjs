import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("native reference clipboard, selection and manual-copy fallback", { timeout: 240_000 }, () => checkBrowser("browser_smoke.py"));
test("drawing transitions retain layout and report genuine context loss", { timeout: 240_000 }, () => checkBrowser("draw_transition.py"));
test("explosion retains an orbited, panned and zoomed camera", { timeout: 240_000 }, () => checkBrowser("explode_camera.py"));
test("Studio appearance, projections and capture agree", { timeout: 240_000 }, () => checkBrowser("studio_views.py"));
