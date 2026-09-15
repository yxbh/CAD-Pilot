import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAWING_LIMITS, addStroke, appendStrokePoint, clearDrawing, emptyDrawing, eraseStrokes,
  geometryPath, getImageBounds, hitTestStroke, normalizedPoint, redoDrawing, replaceDrawing,
  strokeGeometry, undoDrawing, validateDrawing,
} from '../shared/drawing.mjs';

const stroke = (id = 'stroke-1', tool = 'pen', points = [[0.1, 0.2], [0.8, 0.7]], extra = {}) =>
  ({ id, tool, color: '#84dec8', width: 3, points, ...extra });
const stateWith = (...strokes) => ({ past: [], present: strokes, future: [] });
const frame = (count, pointCount, prefix = 's') => Array.from({ length: count }, (_, index) =>
  stroke(`${prefix}${index}`, 'pen', Array.from({ length: pointCount }, () => [0.5, 0.5])));

test('empty states are independent, strictly validated, and returned without coercion', () => {
  const first = emptyDrawing();
  assert.deepEqual(first, { past: [], present: [], future: [] });
  assert.notEqual(first.present, emptyDrawing().present);
  assert.equal(validateDrawing(first), first);
  for (const tool of ['pen', 'line', 'arrow', 'double-arrow', 'rectangle', 'ellipse', 'highlight']) {
    assert.equal(validateDrawing(stateWith(stroke('valid', tool))).present[0].tool, tool);
  }
  assert.doesNotThrow(() => validateDrawing(stateWith(stroke('dot', 'pen', [[0, 1]], { width: 16, color: '#ABCDEF' }))));
});

test('mapping accounts for offset, aspect fit, letterboxing, and original pixel dimensions', () => {
  const bounds = { left: 10, top: 20, width: 400, height: 400 };
  assert.deepEqual(getImageBounds(bounds, 800, 400), { left: 10, top: 120, width: 400, height: 200 });
  assert.deepEqual(normalizedPoint(210, 220, bounds, 800, 400), [0.5, 0.5]);
  assert.deepEqual(normalizedPoint(10, 120, bounds, 800, 400), [0, 0]);
  assert.deepEqual(normalizedPoint(410, 320, bounds, 800, 400), [1, 1]);
  assert.equal(normalizedPoint(210, 119.99, bounds, 800, 400), null);
  assert.equal(normalizedPoint(210, 321, bounds, 800, 400), null);
  assert.equal(normalizedPoint(9, 220, bounds, 800, 400), null);
  assert.deepEqual(getImageBounds(bounds, 400, 800), { left: 110, top: 20, width: 200, height: 400 });
  assert.equal(normalizedPoint(100, 100, bounds, 400, 800), null);
  assert.deepEqual(normalizedPoint(110, 20, bounds, 400, 800), [0, 0]);
  assert.throws(() => normalizedPoint(NaN, 20, bounds, 400, 800), /finite/);
  assert.throws(() => getImageBounds({ ...bounds, height: 0 }, 400, 800), /dimensions/);
  assert.throws(() => getImageBounds(bounds, Infinity, 800), /dimensions/);
});

test('history supports add, erase, reversible clear, undo and redo without input mutation', () => {
  const empty = emptyDrawing();
  const first = addStroke(empty, stroke('first'));
  const second = addStroke(first, stroke('second'));
  const erased = eraseStrokes(second, ['first']);
  assert.deepEqual(erased.present.map(item => item.id), ['second']);
  assert.deepEqual(undoDrawing(erased).present, second.present);
  assert.deepEqual(redoDrawing(undoDrawing(erased)), erased);
  const cleared = clearDrawing(second);
  assert.deepEqual(cleared.present, []);
  assert.deepEqual(undoDrawing(cleared).present, second.present);
  assert.deepEqual(redoDrawing(undoDrawing(cleared)), cleared);
  assert.deepEqual(empty, emptyDrawing());
  assert.equal(first.present.length, 1);
  assert.equal(second.present.length, 2);
  assert.equal(clearDrawing(empty), empty);
  assert.equal(undoDrawing(empty), empty);
  assert.equal(redoDrawing(empty), empty);
  assert.equal(eraseStrokes(second, []), second);
  assert.equal(replaceDrawing(second, second.present), second);
});

test('new changes after undo discard redo, and total history never exceeds 30 frames', () => {
  let current = emptyDrawing();
  for (let index = 0; index < 50; index++) current = addStroke(current, stroke(`s${index}`));
  assert.equal(current.past.length, DRAWING_LIMITS.historyFrames);
  let undone = current;
  for (let index = 0; index < 35; index++) undone = undoDrawing(undone);
  assert.equal(undone.future.length, DRAWING_LIMITS.historyFrames);
  assert.equal(undone.present.length, 20);
  for (let index = 0; index < 35; index++) undone = redoDrawing(undone);
  assert.deepEqual(undone, current);
  const branch = addStroke(undoDrawing(current), stroke('branch'));
  assert.equal(branch.future.length, 0);
  assert.equal(redoDrawing(branch), branch);
});

test('history pruning respects the aggregate point cap while retaining the immediate undo', () => {
  const big = frame(50, 2000);
  const original = { past: [big, big], present: big, future: [] };
  assert.equal(validateDrawing(original), original);
  const next = replaceDrawing(original, frame(51, 2000, 'new'));
  assert.equal(next.past.length, 1);
  assert.equal(undoDrawing(next).present, big);
  assert.doesNotThrow(() => validateDrawing(redoDrawing(undoDrawing(next))));
  const nearlyFull = stateWith(...frame(100, 2000));
  assert.throws(() => addStroke(nearlyFull, stroke('more')), /point budget/);
  assert.deepEqual(undoDrawing(clearDrawing(nearlyFull)).present, nearlyFull.present);
});

test('rejects malformed states, unknown fields, missing frames, duplicate ids and invalid strokes', () => {
  const invalidStates = [
    null, [], {}, { past: [], present: [] }, { ...emptyDrawing(), ignored: true },
    { ...emptyDrawing(), present: null }, { ...emptyDrawing(), past: {} },
    { ...emptyDrawing(), past: [null] }, { ...emptyDrawing(), future: [null] },
    { ...emptyDrawing(), past: Array(1) }, { ...emptyDrawing(), present: Array(1) },
    { ...emptyDrawing(), past: Array.from({ length: 16 }, () => []), future: Array.from({ length: 15 }, () => []) },
    stateWith(stroke(), stroke()),
  ];
  for (const invalid of invalidStates) assert.throws(() => validateDrawing(invalid), /Drawing:/);
  const invalidStrokes = [
    { ...stroke(), ignored: true },
    stroke('', 'pen'), stroke('   ', 'pen'), stroke('x'.repeat(129), 'pen'), stroke('bad\nid'),
    stroke('x', 'erase'), stroke('x', 'polygon'), stroke('x', 'Pen'),
    stroke('x', 'pen', [], { width: 2 }),
    ...[-1, 0, 16.1, Infinity, NaN, '3'].map(width => stroke('x', 'pen', [[0, 0]], { width })),
    ...['red', '#abc', '#abcd1234', '84dec8', '#zzzzzz', null].map(color => stroke('x', 'pen', [[0, 0]], { color })),
    ...[[NaN, 0], [0, Infinity], [-0.01, 0], [0, 1.01], ['0', 0], [0], [0, 0, 0], null].map(p => stroke('x', 'pen', [p])),
    stroke('x', 'line', [[0, 0]]), stroke('x', 'ellipse', [[0, 0], [0.5, 0.5], [1, 1]]),
  ];
  for (const invalid of invalidStrokes) assert.throws(() => validateDrawing(stateWith(invalid)), /Drawing:/);
  assert.throws(() => eraseStrokes(stateWith(stroke()), ['unknown']), /existing strokes/);
  assert.throws(() => eraseStrokes(stateWith(stroke()), null), /erase ids/);
  assert.throws(() => eraseStrokes(stateWith(stroke()), Array(1)), /erase ids/);
});

test('rejects every size cap in present and history, including total point abuse', () => {
  assert.doesNotThrow(() => validateDrawing(stateWith(...frame(200, 1))));
  assert.throws(() => validateDrawing(stateWith(...frame(201, 1))), /200 strokes/);
  assert.doesNotThrow(() => validateDrawing(stateWith(...frame(1, 2000))));
  assert.throws(() => validateDrawing(stateWith(...frame(1, 2001))), /2000 points/);
  assert.throws(() => validateDrawing({ ...emptyDrawing(), future: [frame(201, 1)] }), /200 strokes/);
  assert.throws(() => validateDrawing({ ...emptyDrawing(), past: [frame(1, 2001)] }), /2000 points/);
  assert.throws(() => validateDrawing(stateWith(...frame(151, 2000))), /300000 points/);
  const big = frame(76, 2000);
  assert.throws(() => validateDrawing({ past: [big], present: big, future: [] }), /300000 points/);
  assert.throws(() => validateDrawing({ past: [], present: big, future: [big] }), /300000 points/);
  assert.throws(() => addStroke(stateWith(...frame(200, 1)), stroke('extra')), /200 strokes/);
});

test('freehand ignores subpixel twitch, retains final points and samples long gestures within the cap', () => {
  let pen = stroke('pen', 'pen', [[0, 0]]);
  assert.equal(appendStrokePoint(pen, [0.0001, 0], 1000, 500), pen);
  pen = appendStrokePoint(pen, [0.0001, 0], 1000, 500, true);
  assert.equal(pen.points.length, 2);
  pen = stroke('long', 'pen', Array.from({ length: 2000 }, (_, index) => [index / 4000, 0.5]));
  const next = appendStrokePoint(pen, [0.8, 0.5], 1000, 500);
  assert.ok(next.points.length < 2000);
  assert.deepEqual(next.points[0], pen.points[0]);
  assert.deepEqual(next.points.at(-1), [0.8, 0.5]);
  assert.equal(pen.points.length, 2000);
  assert.doesNotThrow(() => validateDrawing(stateWith(next)));
  const line = appendStrokePoint(stroke('line', 'line'), [1, 1], 800, 400);
  assert.deepEqual(line.points, [[0.1, 0.2], [1, 1]]);
  assert.throws(() => appendStrokePoint(pen, [1.1, 0], 1000, 500), /normalized/);
});

test('shared geometry gives original-pixel widths, non-square ellipses, and arrows at both ends', () => {
  const ellipse = strokeGeometry(stroke('e', 'ellipse', [[0.2, 0.2], [0.8, 0.8]]), 1000, 500)[0];
  assert.deepEqual(ellipse, { kind: 'ellipse', cx: 500, cy: 250, rx: 300, ry: 150, fill: false, opacity: 1 });
  assert.match(geometryPath(ellipse), /A 300 150/);
  const rectangle = strokeGeometry(stroke('r', 'rectangle', [[0.8, 0.8], [0.2, 0.2]]), 1000, 500)[0];
  assert.deepEqual(rectangle.points, [[200, 100], [800, 100], [800, 400], [200, 400]]);
  assert.equal(rectangle.fill, false);
  assert.match(geometryPath(rectangle), / Z$/);
  const highlight = strokeGeometry(stroke('h', 'highlight'), 1000, 500)[0];
  assert.equal(highlight.fill, true);
  assert.equal(highlight.opacity, 0.25);
  const arrow = strokeGeometry(stroke('a', 'double-arrow', [[0.2, 0.5], [0.8, 0.5]]), 1000, 500);
  assert.equal(arrow.length, 3);
  assert.deepEqual(arrow[1].points[0], [800, 250]);
  assert.deepEqual(arrow[2].points[0], [200, 250]);
  assert.ok(arrow[1].points[1][0] < 800);
  assert.ok(arrow[2].points[1][0] > 200);
  assert.equal(strokeGeometry(stroke('a', 'arrow'), 1000, 500).length, 2);
  const dot = strokeGeometry(stroke('p', 'pen', [[0.5, 0.5]], { width: 8 }), 1000, 500)[0];
  assert.equal(dot.rx, 4);
  assert.equal(dot.ry, 4);
});

test('eraser uses stroke-distance hits rather than rectangle or ellipse bounding-box interiors', () => {
  const rectangle = stroke('r', 'rectangle', [[0.2, 0.2], [0.8, 0.8]]);
  assert.equal(hitTestStroke(rectangle, [0.5, 0.5], 1000, 500), false);
  assert.equal(hitTestStroke(rectangle, [0.2, 0.5], 1000, 500), true);
  assert.equal(hitTestStroke(rectangle, [0.195, 0.5], 1000, 500), true);
  assert.equal(hitTestStroke(rectangle, [0.1, 0.5], 1000, 500), false);
  assert.equal(hitTestStroke({ ...rectangle, tool: 'highlight' }, [0.5, 0.5], 1000, 500), true);
  const ellipse = { ...rectangle, tool: 'ellipse' };
  assert.equal(hitTestStroke(ellipse, [0.5, 0.5], 1000, 500), false);
  assert.equal(hitTestStroke(ellipse, [0.8, 0.2], 1000, 500), false);
  assert.equal(hitTestStroke(ellipse, [0.8, 0.5], 1000, 500), true);
  assert.equal(hitTestStroke(ellipse, [0.5, 0.2], 1000, 500), true);
  const line = stroke('l', 'line', [[0.1, 0.1], [0.9, 0.9]]);
  assert.equal(hitTestStroke(line, [0.5, 0.5], 1000, 500), true);
  assert.equal(hitTestStroke(line, [0.5, 0.1], 1000, 500), false);
  const dot = stroke('p', 'pen', [[0.5, 0.5]], { width: 8 });
  assert.equal(hitTestStroke(dot, [0.509, 0.5], 1000, 500), true);
  assert.equal(hitTestStroke(dot, [0.52, 0.5], 1000, 500), false);
  const arrow = stroke('a', 'double-arrow', [[0.2, 0.5], [0.8, 0.5]], { width: 10 });
  assert.equal(hitTestStroke(arrow, [0.225, 0.515], 1000, 500, 0), true);
  assert.equal(hitTestStroke(arrow, [0.775, 0.515], 1000, 500, 0), true);
  assert.throws(() => hitTestStroke(arrow, [0.5, 0.5], 1000, 500, -1), /tolerance/);
});
