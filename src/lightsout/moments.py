"""Turn raw race data into the moments worth jumping to.

Every detector is a pure function over the compiled drivers, so the race logic
can be tested without touching the network.
"""

from __future__ import annotations

import math
from bisect import bisect_right

LEAD_MATCH_SECONDS = 10
# Seconds around a pit stop in which a position change is not an on-track pass.
PIT_WINDOW = 45
# A pass only counts if the order still holds this long afterwards.
STICK_SECONDS = 15
# Timing also reshuffles cars that are nowhere near each other, so a real pass needs them side by side.
PASS_MAX_METRES = 60
# Two cars must be this close before a pit stop for it to count as a battle.
UNDERCUT_MAX_GAP = 6.0
UNDERCUT_MAX_LAPS = 3
# Order is read this long before the first car enters the pit lane.
UNDERCUT_LEAD_IN = 15
# Time for the second car's stop to shake out before comparing the order.
UNDERCUT_SETTLE = 45
WET_TYRES = {"INTERMEDIATE", "WET"}


def position_at(driver: dict, t: float) -> int | None:
    times = [change[0] for change in driver["pos"]]
    index = bisect_right(times, t) - 1
    return driver["pos"][index][1] if index >= 0 else None


def gap_at(driver: dict, t: float, step: float) -> float | None:
    gaps = driver["gaps"]
    index = int(t // step)
    return gaps[index] if 0 <= index < len(gaps) else None


def lap_at(driver: dict, t: float) -> int:
    return max(bisect_right(driver["laps"], t), 1)


def compound_at(driver: dict, lap: int) -> str | None:
    compound = None
    for stint in driver["stints"]:
        if stint["from"] <= lap:
            compound = stint["compound"]
    return compound


def metres_apart(first: dict, second: dict, t: float) -> float:
    index = int(t)
    return math.hypot(first["x"][index] - second["x"][index], first["y"][index] - second["y"][index])


def is_neutralised(status: list[dict], t: float) -> bool:
    return any(period["start"] <= t <= period["end"] for period in status)


def _near_pit(driver: dict, t: float) -> bool:
    return any(abs(stop["t"] - t) <= PIT_WINDOW for stop in driver["pits"])


def _retiring(driver: dict, t: float) -> bool:
    return driver["retired_at"] is not None and t >= driver["retired_at"] - 60


def find_passes(overtakes: list[dict], by_number: dict[int, dict], status: list[dict], finish: float) -> list[dict]:
    """Keep only real on-track passes.

    OpenF1 reports every swap in the running order, which includes cars that
    pitted or retired, anything under a safety car, and the reshuffle once the
    chequered flag falls.
    """
    moments = []
    for overtake in overtakes:
        attacker = by_number.get(overtake["attacker"])
        defender = by_number.get(overtake["defender"])
        t = overtake["t"]
        if attacker is None or defender is None or not 0 <= t < finish:
            continue
        if metres_apart(attacker, defender, t) > PASS_MAX_METRES:
            continue
        if is_neutralised(status, t) or _near_pit(attacker, t) or _near_pit(defender, t):
            continue
        if _retiring(attacker, t) or _retiring(defender, t):
            continue
        held_a, held_d = position_at(attacker, t + STICK_SECONDS), position_at(defender, t + STICK_SECONDS)
        if held_a is None or held_d is None or held_a > held_d:
            continue
        moments.append({
            "t": t,
            "kind": "pass",
            "title": f"{attacker['code']} passes {defender['code']}",
            "detail": f"For P{overtake['position']}",
            "drivers": [attacker["num"], defender["num"]],
            "major": overtake["position"] <= 3,
        })
    return moments


def find_strategy_swings(drivers: list[dict], status: list[dict], gap_step: float) -> list[dict]:
    """Find pit battles that changed the order of two cars running close together.

    The car behind pitting first and coming out ahead is an undercut. The car
    ahead pitting first and losing the place to the car that stayed out is an
    overcut. Stops under a safety car are skipped because they are cheap for
    everyone, and stops around wet tyres because those are weather calls.
    Results are merged per driver so one good stop reads as one moment.
    """
    swings: dict[tuple, dict] = {}
    for first in drivers:
        for second in drivers:
            if first is second:
                continue
            for early in first["pits"]:
                for late in second["pits"]:
                    laps_apart = late["lap"] - early["lap"]
                    if not 1 <= laps_apart <= UNDERCUT_MAX_LAPS:
                        continue
                    if is_neutralised(status, early["t"]) or is_neutralised(status, late["t"]):
                        continue
                    if _on_wets(first, early) or _on_wets(second, late):
                        continue
                    swing = _compare_stops(first, second, early, late, gap_step)
                    if swing:
                        key = (swing["kind"], swing["winner"]["num"], swing["winner_stop"]["lap"])
                        swings.setdefault(key, {"swing": swing, "beaten": []})["beaten"].append(swing)
    return [_describe(group["swing"], group["beaten"]) for group in swings.values()]


def _on_wets(driver: dict, stop: dict) -> bool:
    return bool({compound_at(driver, stop["lap"]), compound_at(driver, stop["lap"] + 1)} & WET_TYRES)


def _compare_stops(first: dict, second: dict, early: dict, late: dict, gap_step: float) -> dict | None:
    before, after = early["t"] - UNDERCUT_LEAD_IN, late["t"] + UNDERCUT_SETTLE
    if _retiring(first, after) or _retiring(second, after):
        return None
    pos_first, pos_second = position_at(first, before), position_at(second, before)
    end_first, end_second = position_at(first, after), position_at(second, after)
    if None in (pos_first, pos_second, end_first, end_second):
        return None
    gap_first, gap_second = gap_at(first, before, gap_step), gap_at(second, before, gap_step)
    if gap_first is None or gap_second is None or abs(gap_first - gap_second) > UNDERCUT_MAX_GAP:
        return None

    if pos_first > pos_second and end_first < end_second:
        kind, winner, loser, winner_stop, loser_stop = "undercut", first, second, early, late
    elif pos_first < pos_second and end_first > end_second:
        kind, winner, loser, winner_stop, loser_stop = "overcut", second, first, late, early
    else:
        return None
    return {"t": after, "kind": kind, "winner": winner, "loser": loser, "winner_stop": winner_stop,
            "loser_stop": loser_stop, "position": min(end_first, end_second)}


def _describe(first_swing: dict, swings: list[dict]) -> dict:
    winner, kind = first_swing["winner"], first_swing["kind"]
    swings = sorted(swings, key=lambda swing: swing["t"])
    rivals = ", ".join(f"{swing['loser']['code']} lap {swing['loser_stop']['lap']}" for swing in swings)
    return {
        "t": swings[-1]["t"],
        "kind": kind,
        "title": f"{winner['code']} {kind}s {', '.join(swing['loser']['code'] for swing in swings)}",
        "detail": f"Stopped lap {first_swing['winner_stop']['lap']}. Rival stops: {rivals}.",
        "drivers": [winner["num"], swings[0]["loser"]["num"]],
        "major": min(swing["position"] for swing in swings) <= 5,
    }


def find_lead_changes(drivers: list[dict]) -> list[dict]:
    changes = sorted(
        (t, driver["num"]) for driver in drivers for t, position in driver["pos"] if position == 1 and t > 0
    )
    by_number = {driver["num"]: driver for driver in drivers}
    moments = []
    for t, number in changes:
        driver = by_number[number]
        moments.append({
            "t": t,
            "kind": "lead",
            "title": f"{driver['code']} takes the lead",
            "detail": "",
            "drivers": [number],
            "major": True,
        })
    return moments


def find_retirements(drivers: list[dict]) -> list[dict]:
    moments = []
    for driver in drivers:
        retired_at = driver["retired_at"]
        if retired_at is None:
            continue
        started = retired_at > 0
        moments.append({
            "t": retired_at,
            "kind": "retire",
            "title": f"{driver['code']} is out" if started else f"{driver['code']} did not start",
            "detail": "" if started else "Out before the lights went out",
            "drivers": [driver["num"]],
            "major": True,
        })
    return moments


def find_fastest_stop(drivers: list[dict]) -> list[dict]:
    stops = [(stop["stop"], stop, driver) for driver in drivers for stop in driver["pits"] if stop["stop"]]
    if not stops:
        return []
    seconds, stop, driver = min(stops, key=lambda item: item[0])
    return [{
        "t": stop["t"],
        "kind": "pit",
        "title": f"Fastest stop: {driver['code']}",
        "detail": f"{seconds:.1f}s stationary on lap {stop['lap']}",
        "drivers": [driver["num"]],
        "major": False,
    }]


def find_status_moments(status: list[dict]) -> list[dict]:
    names = {"SC": "Safety car", "VSC": "Virtual safety car", "RED": "Red flag"}
    return [{
        "t": period["start"],
        "kind": "status",
        "title": names[period["kind"]],
        "detail": f"Lasted {(period['end'] - period['start']) / 60:.1f} min",
        "drivers": [],
        "major": True,
    } for period in status]


def find_radio(radio: list[dict], by_number: dict[int, dict], finish: float) -> list[dict]:
    """Team radio stays on F1's servers, so each moment only stores the link."""
    return [{
        "t": clip["t"],
        "kind": "radio",
        "title": f"{by_number[clip['num']]['code']} on team radio",
        "detail": "",
        "drivers": [clip["num"]],
        "major": False,
        "url": clip["url"],
    } for clip in radio if clip["num"] in by_number and 0 <= clip["t"] <= finish + 60]


def _drop_duplicate_leads(moments: list[dict]) -> list[dict]:
    """A pass for P1 already says the lead changed, and it also names who lost it."""
    passes = [moment for moment in moments if moment["kind"] == "pass" and moment["detail"] == "For P1"]
    return [moment for moment in moments if not (
        moment["kind"] == "lead"
        and any(item["drivers"][0] == moment["drivers"][0] and abs(item["t"] - moment["t"]) <= LEAD_MATCH_SECONDS
                for item in passes)
    )]


def detect(drivers: list[dict], overtakes: list[dict], status: list[dict], gap_step: float, finish: float,
           radio: list[dict] = ()) -> list[dict]:
    by_number = {driver["num"]: driver for driver in drivers}
    moments = (
        find_passes(overtakes, by_number, status, finish)
        + find_strategy_swings(drivers, status, gap_step)
        + find_lead_changes(drivers)
        + find_retirements(drivers)
        + find_fastest_stop(drivers)
        + find_status_moments(status)
        + find_radio(radio, by_number, finish)
    )
    return sorted(_drop_duplicate_leads(moments), key=lambda moment: moment["t"])
