import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function replaceFile(temporary, destination, operations = { rename, delay }) {
  for (let attempt = 0; ; attempt++) {
    try { await operations.rename(temporary, destination); return; }
    catch (error) {
      // Windows readers/antivirus can briefly prevent an otherwise atomic replacement.
      if (attempt >= 7 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await operations.delay(25 * (attempt + 1));
    }
  }
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
  try { await replaceFile(temporary, file); }
  catch (error) {
    try { await unlink(temporary); }
    catch (cleanup) { if (cleanup.code !== "ENOENT") throw new AggregateError([error, cleanup], "Saving JSON and temporary-file cleanup failed"); }
    throw error;
  }
}
