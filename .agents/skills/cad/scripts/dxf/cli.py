from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path
import sys

if __package__ in {None, ""}:
    scripts_dir = Path(__file__).resolve().parents[1]
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

from common.generation import generate_dxf_targets, run_cli


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="scripts/dxf", description="Generate explicit DXF targets from Python sources.")
    parser.add_argument("targets", nargs="+", help="Explicit Python source file defining gen_dxf() to generate.")
    parser.add_argument(
        "-o",
        "--output",
        metavar="PATH",
        help="Write the generated DXF file to this path. Valid only with one generated Python target.",
    )
    parser.add_argument("--verbose", action="store_true", help="Show detailed progress and timing information.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    return run_cli(
        build_parser(),
        argv,
        lambda args: generate_dxf_targets(args.targets, output=args.output, verbose=bool(args.verbose)),
    )


if __name__ == "__main__":
    raise SystemExit(main())
