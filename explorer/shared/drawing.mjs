export const DRAWING_LIMITS = Object.freeze({
  strokes: 200,
  pointsPerStroke: 2000,
  historyFrames: 30,
  totalPoints: 300000,
});

const tools = new Set(['pen', 'line', 'arrow', 'double-arrow', 'rectangle', 'ellipse', 'highlight']);

function fail(message) {
  throw new Error(`Drawing: ${message}`);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object.`);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail(`${label} must contain exactly ${keys.join(', ')}.`);
  }
}

function point(value, label = 'point') {
  if (!Array.isArray(value) || value.length !== 2
    || !Number.isFinite(value[0]) || !Number.isFinite(value[1])
    || value[0] < 0 || value[0] > 1 || value[1] < 0 || value[1] > 1) {
    fail(`${label} must be two finite normalized coordinates between 0 and 1.`);
  }
}

function validateStroke(value, label) {
  exactObject(value, ['id', 'tool', 'color', 'width', 'points'], label);
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128 || /[\u0000-\u001f]/u.test(value.id)) {
    fail(`${label}.id must be a nonempty string of at most 128 characters without control characters.`);
  }
  if (!tools.has(value.tool)) fail(`${label}.tool is not a supported drawing tool.`);
  if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value.color)) fail(`${label}.color must be #rrggbb.`);
  if (!Number.isFinite(value.width) || value.width < 1 || value.width > 16) fail(`${label}.width must be between 1 and 16 original-image pixels.`);
  if (!Array.isArray(value.points) || !value.points.length || value.points.length > DRAWING_LIMITS.pointsPerStroke) {
    fail(`${label}.points must contain 1 to ${DRAWING_LIMITS.pointsPerStroke} points.`);
  }
  if (value.tool !== 'pen' && value.points.length !== 2) fail(`${label}.${value.tool} requires exactly two endpoints.`);
  for (let i = 0; i < value.points.length; i++) point(value.points[i], `${label}.points[${i}]`);
}

export function emptyDrawing() {
  return { past: [], present: [], future: [] };
}

export function validateDrawing(value) {
  exactObject(value, ['past', 'present', 'future'], 'state');
  if (!Array.isArray(value.past) || !Array.isArray(value.future)) fail('past and future must be arrays of frames.');
  if (value.past.length + value.future.length > DRAWING_LIMITS.historyFrames) {
    fail(`history may contain at most ${DRAWING_LIMITS.historyFrames} total frames.`);
  }
  let total = 0;
  const frames = [
    ['present', value.present],
    ...value.past.map((frame, index) => [`past[${index}]`, frame]),
    ...value.future.map((frame, index) => [`future[${index}]`, frame]),
  ];
  for (const entry of frames) {
    if (!entry) fail('history must not contain missing frames.');
    const [label, frame] = entry;
    if (!Array.isArray(frame) || frame.length > DRAWING_LIMITS.strokes) fail(`${label} must be an array of at most ${DRAWING_LIMITS.strokes} strokes.`);
    const ids = new Set();
    for (let index = 0; index < frame.length; index++) {
      const stroke = frame[index];
      validateStroke(stroke, `${label}[${index}]`);
      if (ids.has(stroke.id)) fail(`${label} contains duplicate stroke id "${stroke.id}".`);
      ids.add(stroke.id);
      total += stroke.points.length;
      if (total > DRAWING_LIMITS.totalPoints) fail(`all frames together may contain at most ${DRAWING_LIMITS.totalPoints} points.`);
    }
  }
  return value;
}

function framePoints(frame) {
  return frame.reduce((sum, stroke) => sum + stroke.points.length, 0);
}

export function replaceDrawing(state, present) {
  validateDrawing(state);
  validateDrawing({ past: [], present, future: [] });
  if (present === state.present) return state;
  const past = [...state.past, state.present].slice(-DRAWING_LIMITS.historyFrames);
  let total = framePoints(present) + past.reduce((sum, frame) => sum + framePoints(frame), 0);
  // Drop only the oldest history; the immediately preceding frame must remain undoable.
  while (total > DRAWING_LIMITS.totalPoints && past.length > 1) total -= framePoints(past.shift());
  if (total > DRAWING_LIMITS.totalPoints) fail('point budget exceeded; erase or clear some strokes before adding more.');
  return validateDrawing({ past, present, future: [] });
}

export function addStroke(state, stroke) {
  validateDrawing(state);
  return replaceDrawing(state, [...state.present, stroke]);
}

export function eraseStrokes(state, ids) {
  validateDrawing(state);
  if (!Array.isArray(ids) || Array.from(ids).some(id => typeof id !== 'string' || !state.present.some(stroke => stroke.id === id))) {
    fail('erase ids must identify existing strokes.');
  }
  if (!ids.length) return state;
  const removed = new Set(ids);
  return replaceDrawing(state, state.present.filter(stroke => !removed.has(stroke.id)));
}

export function clearDrawing(state) {
  validateDrawing(state);
  return state.present.length ? replaceDrawing(state, []) : state;
}

export function undoDrawing(state) {
  validateDrawing(state);
  if (!state.past.length) return state;
  return validateDrawing({
    past: state.past.slice(0, -1),
    present: state.past.at(-1),
    future: [state.present, ...state.future],
  });
}

export function redoDrawing(state) {
  validateDrawing(state);
  if (!state.future.length) return state;
  return validateDrawing({
    past: [...state.past, state.present],
    present: state.future[0],
    future: state.future.slice(1),
  });
}

function dimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) fail('image dimensions must be positive finite numbers.');
}

export function getImageBounds(bounds, imageWidth, imageHeight) {
  dimensions(imageWidth, imageHeight);
  if (!bounds || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) fail('stage origin must be finite.');
  dimensions(bounds.width, bounds.height);
  const scale = Math.min(bounds.width / imageWidth, bounds.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return { left: bounds.left + (bounds.width - width) / 2, top: bounds.top + (bounds.height - height) / 2, width, height };
}

export function normalizedPoint(clientX, clientY, bounds, imageWidth, imageHeight) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) fail('pointer coordinates must be finite.');
  const image = getImageBounds(bounds, imageWidth, imageHeight);
  const x = (clientX - image.left) / image.width;
  const y = (clientY - image.top) / image.height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : [x, y];
}

export function appendStrokePoint(stroke, next, imageWidth, imageHeight, force = false) {
  validateStroke(stroke, 'stroke');
  point(next);
  dimensions(imageWidth, imageHeight);
  if (stroke.tool !== 'pen') return { ...stroke, points: [stroke.points[0], next] };
  const previous = stroke.points.at(-1);
  const distance = Math.hypot((next[0] - previous[0]) * imageWidth, (next[1] - previous[1]) * imageHeight);
  if (distance === 0 || (!force && distance < 0.75)) return stroke;
  let points = stroke.points;
  // Long stylus gestures are sampled progressively instead of failing mid-stroke.
  if (points.length >= DRAWING_LIMITS.pointsPerStroke) points = points.filter((_, index) => index % 2 === 0 || index === points.length - 1);
  return { ...stroke, points: [...points, next] };
}

function polyline(points, closed = false, fill = false, opacity = 1) {
  return { kind: 'polyline', points, closed, fill, opacity };
}

export function strokeGeometry(stroke, imageWidth, imageHeight) {
  validateStroke(stroke, 'stroke');
  dimensions(imageWidth, imageHeight);
  const points = stroke.points.map(([x, y]) => [x * imageWidth, y * imageHeight]);
  const a = points[0];
  const b = points.at(-1);
  if (stroke.tool === 'pen') {
    if (points.every(p => p[0] === a[0] && p[1] === a[1])) {
      return [{ kind: 'ellipse', cx: a[0], cy: a[1], rx: stroke.width / 2, ry: stroke.width / 2, fill: true, opacity: 1 }];
    }
    return [polyline(points)];
  }
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  const width = Math.abs(b[0] - a[0]);
  const height = Math.abs(b[1] - a[1]);
  if (stroke.tool === 'ellipse' && width > 0 && height > 0) {
    return [{ kind: 'ellipse', cx: left + width / 2, cy: top + height / 2, rx: width / 2, ry: height / 2, fill: false, opacity: 1 }];
  }
  if (stroke.tool === 'rectangle' || stroke.tool === 'highlight') {
    return [polyline([[left, top], [left + width, top], [left + width, top + height], [left, top + height]], true, stroke.tool === 'highlight', stroke.tool === 'highlight' ? 0.25 : 1)];
  }
  const result = [polyline([a, b])];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if ((stroke.tool === 'arrow' || stroke.tool === 'double-arrow') && length > 0) {
    const size = Math.min(Math.max(10, stroke.width * 3), length * (stroke.tool === 'double-arrow' ? 0.4 : 0.65));
    const ux = (b[0] - a[0]) / length;
    const uy = (b[1] - a[1]) / length;
    const head = (tip, sign) => polyline([
      tip,
      [tip[0] - sign * ux * size - uy * size * 0.45, tip[1] - sign * uy * size + ux * size * 0.45],
      [tip[0] - sign * ux * size + uy * size * 0.45, tip[1] - sign * uy * size - ux * size * 0.45],
    ], true, true);
    result.push(head(b, 1));
    if (stroke.tool === 'double-arrow') result.push(head(a, -1));
  }
  return result;
}

export function geometryPath(geometry) {
  if (geometry.kind === 'ellipse') {
    const { cx, cy, rx, ry } = geometry;
    return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
  }
  return geometry.points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ') + (geometry.closed ? ' Z' : '');
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function insidePolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a[1] > p[1]) !== (b[1] > p[1])
      && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function hitTestStroke(stroke, normalized, imageWidth, imageHeight, tolerance = 6) {
  point(normalized);
  if (!Number.isFinite(tolerance) || tolerance < 0) fail('hit tolerance must be a nonnegative pixel distance.');
  const p = [normalized[0] * imageWidth, normalized[1] * imageHeight];
  for (const geometry of strokeGeometry(stroke, imageWidth, imageHeight)) {
    const threshold = tolerance + (geometry.fill ? 0 : stroke.width / 2);
    let vertices;
    if (geometry.kind === 'ellipse') {
      const { cx, cy, rx, ry } = geometry;
      if (geometry.fill && ((p[0] - cx) / rx) ** 2 + ((p[1] - cy) / ry) ** 2 <= 1) return true;
      // Chord error stays under roughly a quarter of an original-image pixel.
      const count = Math.min(4096, Math.max(32, Math.ceil(Math.PI * Math.sqrt(2 * Math.max(rx, ry)))));
      vertices = Array.from({ length: count + 1 }, (_, i) => [cx + rx * Math.cos(i * 2 * Math.PI / count), cy + ry * Math.sin(i * 2 * Math.PI / count)]);
    } else {
      if (geometry.fill && insidePolygon(p, geometry.points)) return true;
      vertices = geometry.closed ? [...geometry.points, geometry.points[0]] : geometry.points;
    }
    for (let i = 1; i < vertices.length; i++) {
      if (segmentDistance(p, vertices[i - 1], vertices[i]) <= threshold) return true;
    }
  }
  return false;
}
