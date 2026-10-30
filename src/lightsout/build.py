"""Compile raw OpenF1 rows into the compact JSON the web player reads."""

from __future__ import annotations

import re
from bisect import bisect_right
from datetime import datetime
from typing import Any

import numpy as np

from . import moments

FRAME_STEP = 1.0  # seconds between car samples; the player interpolates between them
GAP_STEP = 4.0
RUN_OUT = 30  # seconds kept after the last car finishes
TRACK_POINTS = 800
TRACK_LAPS = 15
MIN_TRACK_SAMPLES = 100
MAX_FEED_GAP = 1.5  # seconds without a position sample before a lap is thrown out
CLEAN_LAP_MARGIN = 1.06
MOVING_SPEED = 5
DEFAULT_LANE = 24.0


def epoch(stamp: str) -> float:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def slugify(year: int, name: str) -> str:
    return f"{year}-{re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')}"


def race_start(race_control: list[dict], laps: list[dict]) -> float:
    for message in race_control:
        if message.get("category") == "SessionStatus" and "STARTED" in (message.get("message") or ""):
            return epoch(message["date"])
    starts = [epoch(lap["date_start"]) for lap in laps if lap.get("date_start")]
    if not starts:
        raise ValueError("Race has no lap data yet")
    return min(starts)


def status_periods(race_control: list[dict], start: float, end: float) -> list[dict]:
    """Group race control messages into safety car, VSC and red flag periods."""
    periods: list[dict] = []
    open_period: dict | None = None

    def close(t: float) -> None:
        nonlocal open_period
        if open_period:
            open_period["end"] = round(t, 1)
            periods.append(open_period)
            open_period = None

    for message in sorted(race_control, key=lambda row: row["date"]):
        t = epoch(message["date"]) - start
        text = (message.get("message") or "").upper()
        if t < 0:
            continue
        if message.get("flag") == "RED":
            close(t)
            open_period = {"kind": "RED", "start": round(t, 1)}
        elif message.get("category") == "SafetyCar":
            if "DEPLOYED" in text:
                close(t)
                virtual = "VIRTUAL" in text or "VSC" in text
                open_period = {"kind": "VSC" if virtual else "SC", "start": round(t, 1)}
            elif "ENDING" in text or "IN THIS LAP" in text:
                close(t)
        elif open_period and open_period["kind"] == "RED" and message.get("flag") == "GREEN":
            close(t)
    close(end)
    return periods


def _sample(rows: list[dict], fields: tuple[str, ...], start: float, grid: np.ndarray) -> dict[str, np.ndarray]:
    rows = [row for row in rows if all(row.get(field) is not None for field in fields)]
    if not rows:
        return {field: np.zeros(len(grid)) for field in fields}
    times = np.array([epoch(row["date"]) - start for row in rows])
    order = np.argsort(times)
    return {field: np.interp(grid, times[order], np.array([row[field] for row in rows], float)[order])
            for field in fields}


def _previous(rows: list[dict], field: str, start: float, grid: np.ndarray) -> np.ndarray:
    """Hold the last value, for stepped signals such as gear where blending is meaningless."""
    rows = [row for row in rows if row.get(field) is not None]
    if not rows:
        return np.zeros(len(grid), int)
    times = np.array([epoch(row["date"]) - start for row in rows])
    order = np.argsort(times)
    values = np.array([row[field] for row in rows])[order]
    return values[np.clip(np.searchsorted(times[order], grid, side="right") - 1, 0, len(values) - 1)]


def _lap_trace(rows: list[dict], begin: float, finish: float) -> np.ndarray | None:
    """Resample one lap evenly by distance, or return None if its position feed has a gap."""
    rows = [row for row in rows if row.get("x") and row.get("y") and row.get("z")]
    rows = [row for row in rows if begin - 1 <= epoch(row["date"]) <= finish + 1]
    if len(rows) < MIN_TRACK_SAMPLES:
        return None
    times = np.array([epoch(row["date"]) for row in rows])
    order = np.argsort(times)
    times = times[order]
    if np.diff(times).max() > MAX_FEED_GAP:
        return None
    grid = np.linspace(begin, finish, int((finish - begin) * 10) + 1)
    path = np.stack([np.interp(grid, times, np.array([row[key] for row in rows], float)[order]) / 10
                     for key in ("x", "y", "z")], axis=1)
    distance = np.r_[0, np.cumsum(np.hypot(*np.diff(path[:, :2], axis=0).T))]
    even = np.linspace(0, distance[-1], TRACK_POINTS, endpoint=False)
    return np.stack([np.interp(even, distance, path[:, axis]) for axis in range(3)], axis=1)


def _smooth_loop(values: np.ndarray, radius: int) -> np.ndarray:
    kernel = np.ones(radius * 2 + 1) / (radius * 2 + 1)
    return np.convolve(np.r_[values[-radius:], values, values[:radius]], kernel, mode="valid")


def centerline(laps: list[dict], location: dict[int, list[dict]]) -> dict[str, list[float]]:
    """Find the true track shape as the median of many clean laps.

    One lap is not enough: position feeds drop out, which cuts corners, and they
    contain glitches. The median of several laps is immune to both.
    """
    timed = [lap for lap in laps if lap.get("lap_duration") and lap.get("date_start")
             and not lap.get("is_pit_out_lap") and lap.get("lap_number", 1) > 1]
    if not timed:
        raise ValueError("Race has no complete lap to trace the track from")
    fastest = min(lap["lap_duration"] for lap in timed)
    clean = sorted((lap for lap in timed if lap["lap_duration"] < fastest * CLEAN_LAP_MARGIN and location.get(lap["driver_number"])),
                   key=lambda lap: lap["lap_duration"])
    traces = []
    for lap in clean:
        begin = epoch(lap["date_start"])
        trace = _lap_trace(location[lap["driver_number"]], begin, begin + lap["lap_duration"])
        if trace is not None:
            traces.append(trace)
        if len(traces) == TRACK_LAPS:
            break
    if not traces:
        raise ValueError("No lap has enough position data to trace the track")
    middle = np.median(np.stack(traces), axis=0)
    return {
        "x": _smooth_loop(middle[:, 0], 2).round(1).tolist(),
        "y": _smooth_loop(middle[:, 1], 2).round(1).tolist(),
        "z": _smooth_loop(middle[:, 2], 8).round(1).tolist(),
        "laps": len(traces),
    }


def race_finish(race_control: list[dict], start: float, duration: float) -> float:
    for message in race_control:
        if message.get("flag") == "CHEQUERED":
            return epoch(message["date"]) - start
    return duration


def _retired_at(car_rows: list[dict], result: dict, start: float) -> float | None:
    if not (result.get("dnf") or result.get("dns")):
        return None
    moving = [epoch(row["date"]) for row in car_rows if (row.get("speed") or 0) > MOVING_SPEED]
    return max(round(max(moving) - start, 1), 0.0) if moving else 0.0


def _laps(rows: list[dict], start: float) -> list[float]:
    numbered = sorted((row for row in rows if row.get("date_start")), key=lambda row: row["lap_number"])
    return [round(epoch(row["date_start"]) - start, 1) for row in numbered]


def _stints(rows: list[dict]) -> list[dict]:
    # OpenF1 sometimes reports lap_end as 0 on an open stint, so only lap_start is trusted.
    ordered = sorted((row for row in rows if row.get("lap_start") is not None), key=lambda row: row["lap_start"])
    return [{"from": row["lap_start"], "compound": row.get("compound") or "UNKNOWN",
             "age": row.get("tyre_age_at_start") or 0} for row in ordered]


def _pits(rows: list[dict], start: float) -> list[dict]:
    # OpenF1 stamps a stop at pit exit, so step back to the moment the car entered the lane.
    return [{"t": round(epoch(row["date"]) - (row.get("lane_duration") or DEFAULT_LANE) - start, 1),
             "lap": row.get("lap_number") or 0,
             "lane": row.get("lane_duration"), "stop": row.get("stop_duration")}
            for row in sorted(rows, key=lambda row: row["date"])]


def _positions(rows: list[dict], start: float) -> list[list]:
    # Timing starts publishing the grid long before the race, so clamp that to t=0.
    changes: list[list] = []
    for row in sorted(rows, key=lambda row: row["date"]):
        t = max(round(epoch(row["date"]) - start, 1), 0)
        if changes and changes[-1][0] == t:
            changes[-1][1] = row["position"]
        elif not changes or changes[-1][1] != row["position"]:
            changes.append([t, row["position"]])
    return changes


def _gaps(rows: list[dict], start: float, duration: float) -> list[float | None]:
    """Sample gap to leader on a fixed grid. Lapped cars report text such as '+1 LAP' and become null."""
    numeric = [(epoch(row["date"]) - start, row.get("gap_to_leader")) for row in rows]
    numeric.sort(key=lambda item: item[0])
    times = [item[0] for item in numeric]
    gaps: list[float | None] = []
    for index in range(int(duration // GAP_STEP) + 1):
        found = bisect_right(times, index * GAP_STEP) - 1
        value = numeric[found][1] if found >= 0 else None
        gaps.append(round(float(value), 2) if isinstance(value, (int, float)) else None)
    return gaps


def _group(rows: list[dict]) -> dict[int, list[dict]]:
    grouped: dict[int, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["driver_number"], []).append(row)
    return grouped


def compile_race(raw: dict[str, Any]) -> dict[str, Any]:
    session = raw["session"]
    start = race_start(raw["race_control"], raw["laps"])
    lap_ends = [epoch(lap["date_start"]) + lap["lap_duration"] for lap in raw["laps"]
                if lap.get("date_start") and lap.get("lap_duration")]
    duration = float(round(max(lap_ends) - start + RUN_OUT))
    grid = np.arange(0, duration + FRAME_STEP, FRAME_STEP)

    laps, stints, pits = _group(raw["laps"]), _group(raw["stints"]), _group(raw["pit"])
    positions, intervals = _group(raw["position"]), _group(raw["intervals"])
    results = {row["driver_number"]: row for row in raw["session_result"]}

    drivers = []
    for entry in raw["drivers"]:
        number = entry["driver_number"]
        location = raw["location"].get(number, [])
        car = raw["car_data"].get(number, [])
        result = results.get(number, {})
        xy = _sample(location, ("x", "y"), start, grid)
        motion = _sample(car, ("speed", "throttle", "brake"), start, grid)
        position_changes = _positions(positions.get(number, []), start)
        drivers.append({
            "num": number,
            "code": entry["name_acronym"],
            "name": f"{entry.get('first_name') or ''} {entry.get('last_name') or ''}".strip(),
            "team": entry.get("team_name") or "",
            "color": f"#{entry.get('team_colour') or '888888'}",
            "grid": position_changes[0][1] if position_changes else None,
            "result": {key: result.get(key) for key in ("position", "points", "dnf", "dns", "dsq", "number_of_laps")},
            "retired_at": _retired_at(car, result, start),
            "laps": _laps(laps.get(number, []), start),
            "stints": _stints(stints.get(number, [])),
            "pits": _pits(pits.get(number, []), start),
            "pos": position_changes,
            "gaps": _gaps(intervals.get(number, []), start, duration),
            "x": (xy["x"] / 10).round().astype(int).tolist(),
            "y": (xy["y"] / 10).round().astype(int).tolist(),
            "spd": motion["speed"].round().astype(int).tolist(),
            "thr": motion["throttle"].round().astype(int).tolist(),
            "brk": motion["brake"].round().astype(int).tolist(),
            "gear": _previous(car, "n_gear", start, grid).tolist(),
            "drs": [int(value >= 10) for value in _previous(car, "drs", start, grid)],
        })

    radio = [{"t": round(epoch(row["date"]) - start, 1), "num": row["driver_number"], "url": row["recording_url"]}
             for row in raw.get("team_radio", []) if row.get("recording_url")]
    overtakes = [{"t": round(epoch(row["date"]) - start, 1), "attacker": row["overtaking_driver_number"],
                  "defender": row["overtaken_driver_number"], "position": row["position"]}
                 for row in raw["overtakes"]]
    status = status_periods(raw["race_control"], start, duration)
    name = raw.get("meeting_name") or f"{session.get('country_name') or 'Unknown'} Grand Prix"

    return {
        "meta": {
            "slug": slugify(session["year"], name),
            "name": name,
            "year": session["year"],
            "circuit": session.get("circuit_short_name") or session.get("location") or "",
            "date": session["date_start"][:10],
            "laps": max((result.get("number_of_laps") or 0 for result in results.values()), default=0),
        },
        "step": FRAME_STEP,
        "gapStep": GAP_STEP,
        "duration": duration,
        "track": centerline(raw["laps"], raw["location"]),
        "drivers": drivers,
        "status": status,
        "moments": moments.detect(drivers, overtakes, status, GAP_STEP,
                                  race_finish(raw["race_control"], start, duration), radio),
    }
