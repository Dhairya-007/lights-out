"""Build Formula 1 replays: `lightsout races 2025`, `lightsout build 2025 Monaco`, `lightsout season 2025`."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

from .build import compile_race
from .client import OpenF1, OpenF1Error, download_race
from .pack import refresh, write_replay

DEFAULT_OUT = Path("web/data")


def find_races(api: OpenF1, year: int) -> list[dict]:
    rows = api.get("sessions", cache=False, year=year, session_name="Race")
    now = datetime.now(timezone.utc).isoformat()
    finished = (row for row in rows if not row.get("is_cancelled") and row["date_end"] < now)
    return sorted(finished, key=lambda row: row["date_start"])


def pick_race(races: list[dict], query: str) -> dict:
    needle = query.lower()
    matches = [race for race in races
               if needle in " ".join(str(race.get(field) or "") for field in
                                     ("country_name", "location", "circuit_short_name")).lower()]
    if not matches:
        raise SystemExit(f"No race matches '{query}'. Run `lightsout races <year>` to see the options.")
    return matches[0]


def build(api: OpenF1, race: dict, out: Path) -> Path:
    print(f"Building {race['year']} {race['country_name']} ({race['date_start'][:10]})", flush=True)
    replay = compile_race(download_race(api, race, print))
    out.mkdir(parents=True, exist_ok=True)
    path = write_replay(replay, out)
    refresh(out)
    kinds = [moment["kind"] for moment in replay["moments"]]
    print(f"Wrote {path}, {len(kinds)} moments: {kinds.count('pass')} passes, "
          f"{kinds.count('undercut')} undercuts, {kinds.count('overcut')} overcuts", flush=True)
    return path


def built_dates(out: Path) -> set[str]:
    index_path = out / "index.json"
    return {race["date"] for race in json.loads(index_path.read_text())["races"]} if index_path.exists() else set()


def build_season(api: OpenF1, year: int, out: Path, keep_cache: bool) -> int:
    """Build every finished race not built yet, carrying on past any that fail."""
    done = built_dates(out)
    todo = [race for race in find_races(api, year) if race["date_start"][:10] not in done]
    print(f"{year}: {len(todo)} races to build", flush=True)
    failed = []
    for race in todo:
        try:
            build(api, race, out)
        except (OpenF1Error, ValueError, requests.RequestException) as error:
            print(f"Skipped {race['country_name']}: {error}", flush=True)
            failed.append(race["country_name"])
        if not keep_cache:
            shutil.rmtree(api.cache_dir, ignore_errors=True)
            api.cache_dir.mkdir(parents=True)
    if failed:
        print(f"{len(failed)} failed, rerun to retry: {', '.join(failed)}")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lightsout", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    races = commands.add_parser("races", help="list the races in a season")
    races.add_argument("year", type=int)
    compile_cmd = commands.add_parser("build", help="compile a race into a web replay")
    compile_cmd.add_argument("year", type=int)
    compile_cmd.add_argument("race", help="country, city or circuit, such as Monaco")
    compile_cmd.add_argument("--out", type=Path, default=DEFAULT_OUT)
    season = commands.add_parser("season", help="compile every finished race in a season")
    season.add_argument("year", type=int)
    season.add_argument("--out", type=Path, default=DEFAULT_OUT)
    season.add_argument("--keep-cache", action="store_true", help="keep raw downloads, about 180 MB a race")
    commands.add_parser("refresh", help="pack old race files and rebuild the race list").add_argument(
        "--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    if args.command == "refresh":
        print(f"{refresh(args.out)} races in the index")
        return 0

    api = OpenF1()
    try:
        if args.command == "races":
            for race in find_races(api, args.year):
                print(f"{race['date_start'][:10]}  {race['country_name']:<22} {race['circuit_short_name']}")
        elif args.command == "season":
            return build_season(api, args.year, args.out, args.keep_cache)
        else:
            build(api, pick_race(find_races(api, args.year), args.race), args.out)
    except OpenF1Error as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
