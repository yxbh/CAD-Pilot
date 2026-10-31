// The Explorer's test files, named as they are in tests/; a browser scenario's name ends in -browser.test.mjs.
import { readdirSync } from "node:fs";

export const testFiles = () => readdirSync(new URL("../tests/", import.meta.url)).filter((name) => /\.test\.(mjs|ts)$/.test(name)).sort();
export const isBrowser = (file) => file.endsWith("-browser.test.mjs");
