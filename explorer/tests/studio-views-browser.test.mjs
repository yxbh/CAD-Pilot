import test from "node:test";
import { checkBrowser } from "./browser-fixture.mjs";

test("Studio appearance, projections and capture agree", { timeout: 240_000 }, () => checkBrowser("studio_views.py"));
