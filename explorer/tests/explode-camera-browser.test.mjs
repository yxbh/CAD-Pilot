import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("explosion retains an orbited, panned and zoomed camera", { timeout: 240_000 }, () => checkBrowser("explode_camera.py"));
