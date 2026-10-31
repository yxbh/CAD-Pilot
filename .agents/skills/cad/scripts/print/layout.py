"""Plate layout: footprints packed into a plate's usable area, clear of keep-out rectangles."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Rect:
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def depth(self) -> float:
        return self.y1 - self.y0

    def overlaps(self, other: "Rect") -> bool:
        return self.x0 < other.x1 - 1e-9 and other.x0 < self.x1 - 1e-9 and self.y0 < other.y1 - 1e-9 and other.y0 < self.y1 - 1e-9

    def contains(self, other: "Rect") -> bool:
        return self.x0 <= other.x0 + 1e-9 and self.y0 <= other.y0 + 1e-9 and other.x1 <= self.x1 + 1e-9 and other.y1 <= self.y1 + 1e-9

    def moved(self, dx: float, dy: float) -> "Rect":
        return Rect(self.x0 + dx, self.y0 + dy, self.x1 + dx, self.y1 + dy)

    def grown(self, by: float) -> "Rect":
        return Rect(self.x0 - by, self.y0 - by, self.x1 + by, self.y1 + by)


@dataclass(frozen=True)
class Footprint:
    key: object
    width: float
    depth: float
    can_turn: bool = True


@dataclass(frozen=True)
class Placement:
    key: object
    rect: Rect
    turned: bool


def _split(free: list[Rect], used: Rect) -> list[Rect]:
    """Maximal free rectangles left after taking ``used`` out of each one."""
    result = []
    for rect in free:
        if not rect.overlaps(used):
            result.append(rect)
            continue
        if used.x0 > rect.x0:
            result.append(Rect(rect.x0, rect.y0, used.x0, rect.y1))
        if used.x1 < rect.x1:
            result.append(Rect(used.x1, rect.y0, rect.x1, rect.y1))
        if used.y0 > rect.y0:
            result.append(Rect(rect.x0, rect.y0, rect.x1, used.y0))
        if used.y1 < rect.y1:
            result.append(Rect(rect.x0, used.y1, rect.x1, rect.y1))
    return [a for i, a in enumerate(result) if not any(j != i and b.contains(a) and (b != a or j < i) for j, b in enumerate(result))]


def pack(items: list[Footprint], area: Rect, keep_out: list[Rect], gap: float) -> tuple[list[Placement], list[Footprint]]:
    """Place footprints with ``gap`` between parts and around keep-outs, then centre the group when
    it stays clear. Parts keep their heading unless turning some a quarter turn fits more of them.
    Returns the placements and the footprints that did not fit."""
    placed, unplaced = _pack(items, area, keep_out, gap, keep_heading=True)
    if unplaced:
        turned = _pack(items, area, keep_out, gap, keep_heading=False)
        if len(turned[1]) < len(unplaced):
            placed, unplaced = turned
    return _centred(placed, area, keep_out, gap), unplaced


def _pack(items: list[Footprint], area: Rect, keep_out: list[Rect], gap: float, *, keep_heading: bool) -> tuple[list[Placement], list[Footprint]]:
    """Largest first, by best short-side fit among the free rectangles left. With ``keep_heading``
    a part turns only when it fits no other way."""
    # Each part reserves its footprint plus the gap on its far sides, so the area and the
    # keep-outs grow by the gap on those sides too.
    free = [Rect(area.x0, area.y0, area.x1 + gap, area.y1 + gap)]
    for rect in keep_out:
        free = _split(free, Rect(rect.x0 - gap, rect.y0 - gap, rect.x1 + gap, rect.y1 + gap))
    placed: list[Placement] = []
    unplaced: list[Footprint] = []
    for item in sorted(items, key=lambda i: (-max(i.width, i.depth), -i.width * i.depth)):
        options = [[(item.width, item.depth, False)]]
        if item.can_turn and abs(item.width - item.depth) > 1e-9:
            options.append([(item.depth, item.width, True)])
        if not keep_heading:
            options = [[size for sizes in options for size in sizes]]
        best = None
        for sizes in options:
            for width, depth, turned in sizes:
                for rect in free:
                    if width + gap <= rect.width + 1e-9 and depth + gap <= rect.depth + 1e-9:
                        score = (min(rect.width - width, rect.depth - depth), rect.y0, rect.x0)
                        if best is None or score < best[0]:
                            best = (score, Rect(rect.x0, rect.y0, rect.x0 + width, rect.y0 + depth), turned)
            if best is not None:
                break
        if best is None:
            unplaced.append(item)
            continue
        _, body, turned = best
        placed.append(Placement(item.key, body, turned))
        free = _split(free, Rect(body.x0, body.y0, body.x1 + gap, body.y1 + gap))
    return placed, unplaced


def _centred(placed: list[Placement], area: Rect, keep_out: list[Rect], gap: float) -> list[Placement]:
    if not placed:
        return placed
    x0 = min(p.rect.x0 for p in placed)
    y0 = min(p.rect.y0 for p in placed)
    x1 = max(p.rect.x1 for p in placed)
    y1 = max(p.rect.y1 for p in placed)
    dx = (area.x0 + area.x1 - x0 - x1) / 2
    dy = (area.y0 + area.y1 - y0 - y1) / 2
    for shift in ((dx, dy), (dx, 0.0), (0.0, dy)):
        moved = [Placement(p.key, p.rect.moved(*shift), p.turned) for p in placed]
        if all(area.contains(p.rect) and not any(p.rect.overlaps(k.grown(gap)) for k in keep_out) for p in moved):
            return moved
    return placed
