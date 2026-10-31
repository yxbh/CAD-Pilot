// Draws an analysis legend (shared/analysis.mjs analysisLegend) with the 2D canvas, the same way on the page and into
// captured images, so a saved picture carries its own scale.
import { rampColor, type AnalysisLegend } from "../../shared/analysis.mjs";

const WIDTH = 236;
const PAD = 10;
const RAMP_HEIGHT = 10;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const css = (rgb: number[]) => `rgb(${rgb.join(" ")})`;

type Line = { text: string; font: string; color: string; height: number };

function wrap(context: CanvasRenderingContext2D, text: string, font: string, width: number): string[] {
  context.font = font;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
  }
  return line ? [...lines, line] : lines;
}

// Rows from top to bottom, in legend pixels at scale 1; drawLegend and legendSize walk the same list.
function layout(context: CanvasRenderingContext2D, legend: AnalysisLegend) {
  const inner = WIDTH - PAD * 2;
  const rows: ({ kind: "text"; line: Line } | { kind: "ramp" } | { kind: "ticks" } | { kind: "key"; index: number })[] = [];
  const text = (value: string, font: string, color: string, height: number) => {
    for (const line of wrap(context, value, font, inner)) rows.push({ kind: "text", line: { text: line, font, color, height } });
  };
  if (legend.map) {
    text(legend.map.title, `600 12px ${FONT}`, "#e7f1f4", 16);
    if (legend.map.ramp) rows.push({ kind: "ramp" }, { kind: "ticks" });
    if (legend.map.note) text(legend.map.note, `10px ${FONT}`, "#a9bfc8", 13);
  }
  legend.keys.forEach((_, index) => rows.push({ kind: "key", index }));
  const height = (row: (typeof rows)[number]) => row.kind === "text" ? row.line.height : row.kind === "ramp" ? RAMP_HEIGHT + 4 : row.kind === "ticks" ? 15 : 16;
  return { rows, height, total: PAD * 2 + rows.reduce((sum, row) => sum + height(row), 0) };
}

const measuring = () => {
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
  return canvas.getContext("2d") as CanvasRenderingContext2D;
};

/** The legend's size in pixels at scale 1. */
export function legendSize(legend: AnalysisLegend): { width: number; height: number } {
  return { width: WIDTH, height: layout(measuring(), legend).total };
}

/** Draws the legend with its top-left corner at x, y, scale pixels per legend pixel. */
export function drawLegend(context: CanvasRenderingContext2D, legend: AnalysisLegend, x: number, y: number, scale: number) {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  const { rows, height, total } = layout(context, legend);
  context.fillStyle = "rgba(11, 23, 34, 0.86)";
  context.strokeStyle = "rgba(122, 152, 166, 0.55)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(0.5, 0.5, WIDTH - 1, total - 1, 6);
  context.fill();
  context.stroke();
  const inner = WIDTH - PAD * 2;
  let top = PAD;
  for (const row of rows) {
    if (row.kind === "text") {
      context.font = row.line.font;
      context.fillStyle = row.line.color;
      context.textBaseline = "middle";
      context.textAlign = "left";
      context.fillText(row.line.text, PAD, top + row.line.height / 2);
    } else if (row.kind === "ramp" && legend.map?.ramp) {
      const gradient = context.createLinearGradient(PAD, 0, PAD + inner, 0);
      for (let step = 0; step <= 64; step++) gradient.addColorStop(step / 64, css(rampColor(legend.map.ramp, step / 64)));
      context.fillStyle = gradient;
      context.fillRect(PAD, top + 2, inner, RAMP_HEIGHT);
    } else if (row.kind === "ticks" && legend.map) {
      context.font = `10px ${FONT}`;
      context.fillStyle = "#c8d9df";
      context.textBaseline = "top";
      for (const [at, label] of legend.map.ticks) {
        context.textAlign = at <= 0 ? "left" : at >= 1 ? "right" : "center";
        context.fillText(label, PAD + at * inner, top + 1);
        context.fillRect(PAD + at * inner - (at >= 1 ? 1 : 0), top - 4, 1, 3);
      }
    } else if (row.kind === "key") {
      const key = legend.keys[row.index];
      if (key.from) {
        const gradient = context.createLinearGradient(PAD, 0, PAD + 14, 0);
        gradient.addColorStop(0, key.from);
        gradient.addColorStop(1, key.color);
        context.fillStyle = gradient;
        context.fillRect(PAD, top + 6, 14, 3);
      } else {
        context.fillStyle = key.color;
        context.fillRect(PAD, top + 3, 10, 10);
      }
      context.font = `11px ${FONT}`;
      context.fillStyle = "#dce9ee";
      context.textBaseline = "middle";
      context.textAlign = "left";
      context.fillText(key.label, PAD + 18, top + 8);
    }
    top += height(row);
  }
  context.restore();
}

/** The legend as plain text, for screen readers. */
export function legendText(legend: AnalysisLegend): string {
  const map = legend.map ? [legend.map.title, legend.map.ticks.map(([, label]) => label).join(" to "), legend.map.note] : [];
  return [...map, ...legend.keys.map((key) => key.label)].filter(Boolean).map((text) => text.replace(/\.$/, "")).join(". ");
}

/** A captured image with the legend drawn into its top-left corner, sized to the image. */
export function withLegend(source: HTMLCanvasElement, legend: AnalysisLegend, pixelRatio: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(source, 0, 0);
  const scale = Math.max(pixelRatio, Math.min(source.width, source.height) / 1000);
  drawLegend(context, legend, 12 * scale, 12 * scale, scale);
  return canvas.toDataURL("image/png");
}
