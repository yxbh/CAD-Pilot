export type CopyResult =
  | { ok: true; method: "clipboard" | "selection" }
  | { ok: false; error: string };

function copyUsingSelection(text: string): boolean {
  const active = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(field);
  try {
    field.select();
    return document.execCommand("copy");
  } finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  }
}

type ClipboardEnvironment = {
  writeText?: (text: string) => Promise<void>;
  legacyCopy: (text: string) => boolean;
};

export function copyFromGesture(text: string, environment?: ClipboardEnvironment): Promise<CopyResult> {
  const writeText = environment ? environment.writeText : navigator.clipboard?.writeText.bind(navigator.clipboard);
  const legacyCopy = environment?.legacyCopy ?? copyUsingSelection;
  const fallback = (): CopyResult => {
    try {
      if (legacyCopy(text)) return { ok: true, method: "selection" };
    } catch {
      return { ok: false, error: "Clipboard access was blocked. Use Copy reference or select the text below and press Ctrl+C." };
    }
    return { ok: false, error: "Clipboard access was blocked. Use Copy reference or select the text below and press Ctrl+C." };
  };
  try {
    if (writeText) return writeText(text).then(() => ({ ok: true, method: "clipboard" } as const), fallback);
  } catch {
    return Promise.resolve(fallback());
  }

  return Promise.resolve(fallback());
}

export function createClipboardWriter(environment?: ClipboardEnvironment) {
  let modernDenied = false;
  return (text: string, retryModern = false): Promise<CopyResult> => {
    if (retryModern) modernDenied = false;
    const writeText = environment ? environment.writeText : navigator.clipboard?.writeText.bind(navigator.clipboard);
    const legacyCopy = environment?.legacyCopy ?? copyUsingSelection;
    return copyFromGesture(text, {
      legacyCopy,
      writeText: !modernDenied && writeText ? (value) => {
        try {
          return writeText(value).catch((error) => { modernDenied = true; throw error; });
        } catch (error) {
          modernDenied = true;
          throw error;
        }

      } : undefined,
    });
  };
}

type PreparedReference = { text: string; title: string };
export type NativeCopyResult = { prepared: PreparedReference; result: CopyResult };

export function copyPreparedReference(
  prepare: Promise<PreparedReference>,
  fallback: (text: string) => Promise<CopyResult>,
  writeItem: ((text: Promise<Blob>) => Promise<void>) | undefined = typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined"
    ? (text) => navigator.clipboard.write([new ClipboardItem({ "text/plain": text })])
    : undefined,
): Promise<NativeCopyResult> {
  const blob = prepare.then(({ text }) => new Blob([text], { type: "text/plain" }));
  // Start the clipboard request during the click; its data resolves after the file exists.
  let writing: Promise<void> | undefined;
  try { writing = writeItem?.(blob); }
  catch (error) { writing = Promise.reject(error); }
  const attempted = writing?.then(() => true, () => false) ?? Promise.resolve(false);
  void blob.catch(() => undefined);
  return prepare.then(async (prepared) => ({
    prepared,
    result: await attempted ? { ok: true, method: "clipboard" } : await fallback(prepared.text),
  }));
}
