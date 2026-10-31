from __future__ import annotations

import itertools
import re
from dataclasses import dataclass


CAD_TOKEN_RE = re.compile(r"^\s*@cad\[([^\]#]+)(?:#([^\]]+))?\]")
OCCURRENCE_SELECTOR_RE = re.compile(r"^o((?:\d+)(?:\.\d+)*)$")
OCCURRENCE_ENTITY_SELECTOR_RE = re.compile(r"^o((?:\d+)(?:\.\d+)*)\.([sfev])(\d+)$")
ENTITY_SELECTOR_RE = re.compile(r"^([sfev])(\d+)$")


@dataclass(frozen=True)
class ParsedSelector:
    selector_type: str
    occurrence_id: str
    ordinal: int | None
    canonical: str


@dataclass(frozen=True)
class ParsedToken:
    line: int
    token: str
    cad_path: str
    selectors: tuple[str, ...]


def _selector_type_for_kind(kind: str) -> str:
    if kind == "s":
        return "shape"
    if kind == "f":
        return "face"
    if kind == "e":
        return "edge"
    return "vertex"


def parse_cad_tokens(text: str) -> list[ParsedToken]:
    tokens: list[ParsedToken] = []
    for line_no, line in enumerate(text.splitlines() or [text], start=1):
        match = CAD_TOKEN_RE.match(line)
        if match is None:
            continue
        cad_path = normalize_cad_path(str(match.group(1) or ""))
        if not cad_path:
            continue
        tokens.append(
            ParsedToken(
                line=line_no,
                token=match.group(0),
                cad_path=cad_path,
                selectors=tuple(normalize_selector_list(str(match.group(2) or ""))),
            )
        )
    return tokens


ABSOLUTE_PREFIX_RE = re.compile(r"^(/|[A-Za-z]:/)")


def normalize_cad_path(raw_cad_path: str) -> str | None:
    """A STEP path without its suffix, relative to the design root.

    A STEP elsewhere keeps its absolute path or its leading ``..`` segments.
    """
    normalized = str(raw_cad_path or "").replace("\\", "/").strip()
    prefix_match = ABSOLUTE_PREFIX_RE.match(normalized)
    prefix = prefix_match.group(1) if prefix_match else ""
    normalized = normalized[len(prefix):].rstrip("/")
    if not normalized:
        return None
    for suffix in (".step", ".stp"):
        if normalized.lower().endswith(suffix):
            normalized = normalized[: -len(suffix)]
            break
    parts = normalized.split("/")
    leading_parents = 0 if prefix else len(parts) - len(list(itertools.dropwhile(lambda part: part == "..", parts)))
    if leading_parents == len(parts) or any(
        not part or part == "." or (part == ".." and index >= leading_parents) for index, part in enumerate(parts)
    ):
        return None
    return prefix + "/".join(parts)


def parse_selector(raw_selector: str, *, inherited_occurrence_id: str = "") -> ParsedSelector | None:
    # Only a leading "#" is the token marker; a later one is selector text.
    selector = str(raw_selector or "").strip()
    if selector.startswith("#"):
        selector = selector[1:]
    if not selector:
        return None

    occurrence_entity_match = OCCURRENCE_ENTITY_SELECTOR_RE.match(selector)
    if occurrence_entity_match:
        occurrence_id = f"o{occurrence_entity_match.group(1)}"
        kind = str(occurrence_entity_match.group(2))
        ordinal = int(occurrence_entity_match.group(3))
        return ParsedSelector(
            selector_type=_selector_type_for_kind(kind),
            occurrence_id=occurrence_id,
            ordinal=ordinal,
            canonical=f"{occurrence_id}.{kind}{ordinal}",
        )

    occurrence_match = OCCURRENCE_SELECTOR_RE.match(selector)
    if occurrence_match:
        occurrence_id = f"o{occurrence_match.group(1)}"
        return ParsedSelector(
            selector_type="occurrence",
            occurrence_id=occurrence_id,
            ordinal=None,
            canonical=occurrence_id,
        )

    entity_match = ENTITY_SELECTOR_RE.match(selector)
    if entity_match:
        kind = str(entity_match.group(1))
        ordinal = int(entity_match.group(2))
        if inherited_occurrence_id:
            return ParsedSelector(
                selector_type=_selector_type_for_kind(kind),
                occurrence_id=inherited_occurrence_id,
                ordinal=ordinal,
                canonical=f"{inherited_occurrence_id}.{kind}{ordinal}",
            )
        return ParsedSelector(
            selector_type=_selector_type_for_kind(kind),
            occurrence_id="",
            ordinal=ordinal,
            canonical=f"{kind}{ordinal}",
        )

    return ParsedSelector(
        selector_type="opaque",
        occurrence_id="",
        ordinal=None,
        canonical=selector,
    )


def normalize_selector_list(raw_selector_list: str) -> list[str]:
    normalized: list[str] = []
    inherited_occurrence_id = ""
    for raw_selector in str(raw_selector_list or "").split(","):
        parsed = parse_selector(raw_selector, inherited_occurrence_id=inherited_occurrence_id)
        if parsed is None:
            continue
        normalized.append(parsed.canonical)
        if parsed.occurrence_id:
            inherited_occurrence_id = parsed.occurrence_id
    return normalized


def build_cad_token(cad_path: str, selector: str = "") -> str:
    normalized_cad_path = normalize_cad_path(cad_path or "")
    if not normalized_cad_path:
        raise ValueError("cad_path is required")
    if not selector:
        return f"@cad[{normalized_cad_path}]"
    return f"@cad[{normalized_cad_path}#{selector}]"
