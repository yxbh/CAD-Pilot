"""Exercise the drawing component and PNG compositor without model/server integration.

Run from the prototype root with the workbench Python environment:
    ..\\..\\..\\.venv\\Scripts\\python.exe tests\\drawing-browser.py
"""

import json
import os
import socket
import subprocess
import threading
from pathlib import Path
from queue import Empty, Queue

from playwright.sync_api import expect, sync_playwright


HARNESS = r"""
import React from 'react';
import {createRoot} from 'react-dom/client';
import DrawingReview from '/src/drawing/DrawingReview.tsx';
import {composeReviewImage} from '/src/drawing/render.ts';
import {emptyDrawing} from '/shared/drawing.mjs';
import '/src/style.css';

const base = document.createElement('canvas');
base.width = 800; base.height = 400;
const context = base.getContext('2d');
context.fillStyle = '#153247'; context.fillRect(0, 0, 800, 400);
context.fillStyle = '#436174'; context.fillRect(0, 0, 40, 400);
window.errors = []; window.actions = []; window.changes = 0;
window.compose = composeReviewImage;
function Harness() {
  const [review, setReview] = React.useState({
    id: 'review-1', version: 1, title: 'Snapshot review',
    createdAt: '2026-01-01T00:00:00Z',
    source: {name: 'assembly.step', sha256: 'a'.repeat(64), topologyRevision: 'revision-1'},
    pose: {explode: 0, direction: 'radial', fixedId: '', hiddenIds: [], selectedIds: [],
      selectedFace: null, camera: {position: [1, 1, 1], target: [0, 0, 0], up: [0, 0, 1], fov: 45}},
    image: {dataUrl: base.toDataURL('image/png'), width: 800, height: 400},
    drawing: emptyDrawing()
  });
  window.review = review;
  window.setReview = setReview;
  return React.createElement(DrawingReview, {
    review, status: 'Saved locally', saving: false,
    onChange: drawing => { window.changes++; setReview(previous => ({...previous, drawing})); },
    onClose: () => window.actions.push('close'),
    onCopyImage: () => window.actions.push('copy'),
    onSaveImage: () => window.actions.push('save'),
    onError: message => window.errors.push(message),
  });
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
"""

SERVER = r"""
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const source = process.env.DRAWING_TEST_HARNESS;
const server = await createServer({
  configFile: false, logLevel: 'error',
  plugins: [react(), {
    name: 'drawing-test-page',
    resolveId(id) { if (id === '/drawing-test.js') return '\0drawing-test'; },
    load(id) { if (id === '\0drawing-test') return source; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__drawing_test__') return next();
        try {
          const html = await server.transformIndexHtml(req.url,
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/drawing-test.js"></script></body></html>');
          res.setHeader('Content-Type', 'text/html'); res.end(html);
        } catch (error) { next(error); }
      });
    },
  }],
  server: {host: '127.0.0.1', port: Number(process.env.DRAWING_TEST_PORT), strictPort: true},
});
await server.listen();
console.log(JSON.stringify({port: server.httpServer.address().port}));
"""


def run():
    root = Path(__file__).resolve().parents[1]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    process = subprocess.Popen(
        ["node", "--input-type=module", "-e", SERVER],
        cwd=root,
        env={**os.environ, "DRAWING_TEST_HARNESS": HARNESS, "DRAWING_TEST_PORT": str(port)},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
    )
    output = Queue()

    def read_output():
        for line in process.stdout:
            output.put(line)
        output.put(None)

    threading.Thread(target=read_output, daemon=True).start()
    try:
        lines = []
        while True:
            try:
                line = output.get(timeout=30)
            except Empty:
                raise AssertionError(f"Drawing browser server did not start: {''.join(lines)}")
            if line is None:
                raise AssertionError(f"Drawing browser server exited: {''.join(lines)}")
            lines.append(line)
            if line.startswith('{"port":'):
                port = json.loads(line)["port"]
                break
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                page = browser.new_page(viewport={"width": 1200, "height": 1000})
                runtime_errors = []
                page.on("pageerror", lambda error: runtime_errors.append(str(error)))
                page.goto(f"http://127.0.0.1:{port}/__drawing_test__")
                expect(page.get_by_role("button", name="Pen", exact=True)).to_be_enabled()
                stage = page.get_by_label("Drawing canvas", exact=True)

                def count():
                    return page.evaluate("window.review.drawing.present.length")

                def point(x, y):
                    bounds = stage.bounding_box()
                    scale = min(bounds["width"] / 800, bounds["height"] / 400)
                    return (
                        bounds["x"] + (bounds["width"] - 800 * scale) / 2 + x * 800 * scale,
                        bounds["y"] + (bounds["height"] - 400 * scale) / 2 + y * 400 * scale,
                    )

                def draw(tool, start, end, steps=8):
                    page.get_by_role("button", name=tool, exact=True).click()
                    page.mouse.move(*point(*start))
                    page.mouse.down()
                    page.mouse.move(*point(*end), steps=steps)
                    page.mouse.up()

                # The wide stage has side letterboxes. No stroke may start there.
                bounds = stage.bounding_box()
                before = count()
                page.mouse.click(bounds["x"] + 2, bounds["y"] + bounds["height"] / 2)
                assert count() == before

                for tool, start, end in [
                    ("Pen", (0.1, 0.1), (0.2, 0.2)),
                    ("Line", (0.1, 0.3), (0.4, 0.3)),
                    ("Arrow", (0.1, 0.45), (0.45, 0.45)),
                    ("Double arrow", (0.1, 0.6), (0.45, 0.6)),
                    ("Rectangle", (0.55, 0.1), (0.9, 0.35)),
                    ("Ellipse", (0.55, 0.45), (0.9, 0.75)),
                    ("Highlight", (0.55, 0.8), (0.9, 0.95)),
                ]:
                    before = count()
                    draw(tool, start, end)
                    assert count() == before + 1, tool
                assert page.evaluate("window.actions") == [], "Drawing must not invoke clipboard actions"

                # Actual PNG pixels are compared with rasterized displayed SVG geometry.
                comparison = page.evaluate(r"""async () => {
                  const blob = await window.compose(window.review);
                  const bitmap = await createImageBitmap(blob);
                  const canvas = document.createElement('canvas');
                  canvas.width = 800; canvas.height = 400;
                  const context = canvas.getContext('2d');
                  context.drawImage(bitmap, 0, 0);
                  const actual = context.getImageData(0, 0, 800, 400).data;
                  const svg = document.querySelector('[aria-label="Drawing canvas"]').cloneNode(true);
                  svg.setAttribute('width', '800'); svg.setAttribute('height', '400');
                  svg.removeAttribute('class');
                  const image = new Image();
                  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], {type: 'image/svg+xml'}));
                  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
                  context.clearRect(0, 0, 800, 400); context.drawImage(image, 0, 0);
                  URL.revokeObjectURL(url); bitmap.close();
                  const expected = context.getImageData(0, 0, 800, 400).data;
                  let mismatched = 0;
                  for (let i = 0; i < actual.length; i += 4) {
                    if (Math.max(...[0, 1, 2, 3].map(channel => Math.abs(actual[i + channel] - expected[i + channel]))) > 12) mismatched++;
                  }
                  const pixel = (x, y) => Array.from(actual.slice((y * 800 + x) * 4, (y * 800 + x) * 4 + 4));
                  return {mismatched, type: blob.type, size: blob.size, base: pixel(300, 20), stripe: pixel(20, 20), highlight: pixel(600, 350)};
                }""")
                assert comparison["mismatched"] < 100, comparison
                assert comparison["type"] == "image/png" and comparison["size"] > 0
                assert comparison["base"] == [21, 50, 71, 255], comparison
                assert comparison["stripe"] == [67, 97, 116, 255], comparison
                assert comparison["highlight"] != comparison["base"], comparison

                page.get_by_role("button", name="Erase", exact=True).click()
                page.mouse.click(*point(0.7, 0.2))
                assert count() == 7, "Unfilled rectangle interiors must not erase"
                page.mouse.click(*point(0.55, 0.2))
                assert count() == 6
                page.get_by_role("button", name="Undo drawing").click()
                assert count() == 7
                page.get_by_role("button", name="Redo drawing").click()
                assert count() == 6
                page.get_by_role("button", name="Undo drawing").click()
                page.get_by_role("button", name="Clear drawing").click()
                assert count() == 0
                page.get_by_role("button", name="Undo drawing").click()
                assert count() == 7

                # Stylus cancellation rolls back both the preview and a pending erase.
                for tool, p in [("Pen", (0.3, 0.8)), ("Erase", (0.55, 0.2))]:
                    page.get_by_role("button", name=tool, exact=True).click()
                    page.mouse.move(*point(*p))
                    page.mouse.down()
                    stage.dispatch_event("pointercancel", {"pointerId": 1})
                    page.mouse.up()
                    assert count() == 7, tool
                page.get_by_role("button", name="Copy marked image").click()
                page.get_by_role("button", name="Save marked image").click()
                page.get_by_role("button", name="Back to model").click()
                assert page.evaluate("window.actions") == ["copy", "save", "close"]

                page.set_viewport_size({"width": 320, "height": 800})
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                expect(stage).to_be_visible()
                draw("Line", (0.1, 0.9), (0.4, 0.9))
                assert count() == 8
                page.set_viewport_size({"width": 1500, "height": 1000})
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")

                # Export rejects corrupt data and mismatched dimensions, not blank fallbacks.
                failures = page.evaluate(r"""async () => {
                  const messages = [];
                  for (const image of [
                    {...window.review.image, dataUrl: 'data:image/png;base64,AAAA'},
                    {...window.review.image, width: 801},
                  ]) {
                    try { await window.compose({...window.review, image}); messages.push('accepted'); }
                    catch (error) { messages.push(error.message); }
                  }
                  return messages;
                }""")
                assert all(message != "accepted" for message in failures), failures
                assert page.evaluate("window.errors") == [], page.evaluate("window.errors")
                page.evaluate("window.setReview(previous => ({...previous, drawing: {...previous.drawing, ignored: true}}))")
                expect(page.get_by_role("alert")).to_contain_text("exactly")
                expect(page.get_by_role("button", name="Pen", exact=True)).to_be_disabled()
                assert page.evaluate("window.errors.length") > 0
                assert runtime_errors == [], runtime_errors
                print(json.dumps({"status": "passed", "composition": comparison, "invalid_images": failures}))
            finally:
                browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


if __name__ == "__main__":
    run()
