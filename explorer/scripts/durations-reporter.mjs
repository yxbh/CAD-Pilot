// A node:test reporter that writes how long each test file's top-level tests took, as JSON:
// {"platform": "<process.platform>", "seconds": {"<file name>": <seconds>}}. scripts/test.mjs adds it when asked for
// --durations; the workbench's tools/durations.mjs gathers what CI's runs wrote into tests/durations.json.
import path from "node:path";

export default async function* durations(source) {
  const seconds = {};
  for await (const { type, data } of source) {
    if ((type === "test:pass" || type === "test:fail") && data.nesting === 0 && data.file) {
      const file = path.basename(data.file);
      seconds[file] = (seconds[file] ?? 0) + data.details.duration_ms / 1000;
    }
  }
  yield `${JSON.stringify({ platform: process.platform, seconds })}\n`;
}
