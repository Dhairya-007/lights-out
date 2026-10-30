from datetime import datetime, timezone

from lightsout import moments
from lightsout.build import _pits, _positions, _stints, epoch, slugify, status_periods

STEP = 4.0
FINISH = 900


def driver(num, code, pos, pits=(), retired_at=None, gap=0.0):
    return {
        "num": num, "code": code, "pos": pos, "pits": list(pits), "retired_at": retired_at,
        "laps": [0, 90, 180, 270, 360, 450, 540, 630], "gaps": [gap] * 400,
        "x": [0] * 1000, "y": [0] * 1000, "stints": [],
    }


def stop(t, lap):
    return {"t": t, "lap": lap, "lane": 22.0, "stop": 2.5}


def overtake(t, attacker=1, defender=2, position=4):
    return {"t": t, "attacker": attacker, "defender": defender, "position": position}


def test_on_track_pass_is_kept():
    a = driver(1, "AAA", [[0, 5], [100, 4]])
    b = driver(2, "BBB", [[0, 4], [100, 5]])
    found = moments.find_passes([overtake(100)], {1: a, 2: b}, [], FINISH)
    assert [m["title"] for m in found] == ["AAA passes BBB"]


def test_position_gained_from_a_pit_stop_is_not_a_pass():
    a = driver(1, "AAA", [[0, 5], [100, 4]])
    b = driver(2, "BBB", [[0, 4], [100, 5]], pits=[stop(90, 2)])
    assert moments.find_passes([overtake(100)], {1: a, 2: b}, [], FINISH) == []


def test_position_gained_under_safety_car_is_not_a_pass():
    a = driver(1, "AAA", [[0, 5], [100, 4]])
    b = driver(2, "BBB", [[0, 4], [100, 5]])
    status = [{"kind": "SC", "start": 80, "end": 200}]
    assert moments.find_passes([overtake(100)], {1: a, 2: b}, status, FINISH) == []


def test_pass_that_is_immediately_undone_is_dropped():
    a = driver(1, "AAA", [[0, 5], [100, 4], [105, 5]])
    b = driver(2, "BBB", [[0, 4], [100, 5], [105, 4]])
    assert moments.find_passes([overtake(100)], {1: a, 2: b}, [], FINISH) == []


def test_passing_a_car_that_is_retiring_is_dropped():
    a = driver(1, "AAA", [[0, 5], [100, 4]])
    b = driver(2, "BBB", [[0, 4], [100, 5]], retired_at=130)
    assert moments.find_passes([overtake(100)], {1: a, 2: b}, [], FINISH) == []


def test_swap_between_cars_far_apart_is_not_a_pass():
    a = driver(1, "AAA", [[0, 5], [100, 4]])
    b = driver(2, "BBB", [[0, 4], [100, 5]])
    b["x"] = [500] * 1000
    assert moments.find_passes([overtake(100)], {1: a, 2: b}, [], FINISH) == []


def test_reshuffle_after_the_flag_is_not_a_pass():
    a = driver(1, "AAA", [[0, 5], [100, 4]])
    b = driver(2, "BBB", [[0, 4], [100, 5]])
    assert moments.find_passes([overtake(100)], {1: a, 2: b}, [], finish=90) == []


def test_undercut_detected_when_car_behind_pits_first_and_emerges_ahead():
    behind = driver(1, "AAA", [[0, 3], [300, 2]], pits=[stop(180, 2)], gap=11.0)
    ahead = driver(2, "BBB", [[0, 2], [300, 3]], pits=[stop(270, 3)], gap=9.0)
    found = moments.find_strategy_swings([behind, ahead], [], STEP)
    assert [m["title"] for m in found] == ["AAA undercuts BBB"]
    assert found[0]["t"] == 270 + moments.UNDERCUT_SETTLE


def test_overcut_detected_when_car_that_stays_out_comes_out_ahead():
    stayed = driver(1, "AAA", [[0, 3], [300, 2]], pits=[stop(270, 3)], gap=11.0)
    pitted = driver(2, "BBB", [[0, 2], [300, 3]], pits=[stop(180, 2)], gap=9.0)
    found = moments.find_strategy_swings([stayed, pitted], [], STEP)
    assert [m["title"] for m in found] == ["AAA overcuts BBB"]


def test_undercut_needs_cars_to_be_close():
    behind = driver(1, "AAA", [[0, 3], [300, 2]], pits=[stop(180, 2)], gap=30.0)
    ahead = driver(2, "BBB", [[0, 2], [300, 3]], pits=[stop(270, 3)], gap=9.0)
    assert moments.find_strategy_swings([behind, ahead], [], STEP) == []


def test_safety_car_stops_are_not_undercuts():
    behind = driver(1, "AAA", [[0, 3], [300, 2]], pits=[stop(180, 2)], gap=11.0)
    ahead = driver(2, "BBB", [[0, 2], [300, 3]], pits=[stop(270, 3)], gap=9.0)
    status = [{"kind": "SC", "start": 170, "end": 200}]
    assert moments.find_strategy_swings([behind, ahead], status, STEP) == []


def test_wet_tyre_stops_are_weather_calls_not_undercuts():
    behind = driver(1, "AAA", [[0, 3], [300, 2]], pits=[stop(180, 2)], gap=11.0)
    ahead = driver(2, "BBB", [[0, 2], [300, 3]], pits=[stop(270, 3)], gap=9.0)
    behind["stints"] = [{"from": 1, "compound": "INTERMEDIATE", "age": 0}, {"from": 3, "compound": "MEDIUM", "age": 0}]
    assert moments.find_strategy_swings([behind, ahead], [], STEP) == []


def test_one_stop_that_beats_two_rivals_is_one_moment():
    winner = driver(1, "AAA", [[0, 4], [300, 2]], pits=[stop(180, 2)], gap=12.0)
    rival_a = driver(2, "BBB", [[0, 3], [300, 3]], pits=[stop(270, 3)], gap=10.0)
    rival_b = driver(3, "CCC", [[0, 2], [300, 4]], pits=[stop(270, 3)], gap=9.0)
    found = moments.find_strategy_swings([winner, rival_a, rival_b], [], STEP)
    assert [m["title"] for m in found] == ["AAA undercuts BBB, CCC"]


def test_non_starter_is_labelled_as_such():
    found = moments.find_retirements([driver(1, "AAA", [[0, 5]], retired_at=0.0)])
    assert found[0]["title"] == "AAA did not start"


def test_lead_changes_ignore_the_starting_order():
    a = driver(1, "AAA", [[0, 1], [300, 2]])
    b = driver(2, "BBB", [[0, 2], [300, 1]])
    assert [m["title"] for m in moments.find_lead_changes([a, b])] == ["BBB takes the lead"]


def test_pass_for_the_lead_replaces_the_lead_change_moment():
    a = driver(1, "AAA", [[0, 2], [100, 1]])
    b = driver(2, "BBB", [[0, 1], [100, 2]])
    found = moments.detect([a, b], [overtake(100, position=1)], [], STEP, FINISH)
    assert [m["title"] for m in found] == ["AAA passes BBB"]


def test_radio_clips_become_linked_moments():
    a = driver(1, "AAA", [[0, 1]])
    found = moments.find_radio([{"t": 50, "num": 1, "url": "https://example.com/a.mp3"},
                                {"t": 50, "num": 99, "url": "https://example.com/b.mp3"}], {1: a}, FINISH)
    assert [(m["title"], m["url"]) for m in found] == [("AAA on team radio", "https://example.com/a.mp3")]


def test_status_periods_group_race_control_messages():
    start = 1_700_000_000
    def at(seconds):
        return datetime.fromtimestamp(start + seconds, timezone.utc).isoformat()

    rows = [
        {"date": at(100), "category": "SafetyCar", "message": "SAFETY CAR DEPLOYED"},
        {"date": at(300), "category": "SafetyCar", "message": "SAFETY CAR IN THIS LAP"},
        {"date": at(500), "category": "SafetyCar", "message": "VIRTUAL SAFETY CAR DEPLOYED"},
        {"date": at(550), "category": "SafetyCar", "message": "VIRTUAL SAFETY CAR ENDING"},
        {"date": at(700), "category": "Flag", "flag": "RED", "message": "RED FLAG"},
        {"date": at(900), "category": "Flag", "flag": "GREEN", "scope": "Track", "message": "GREEN LIGHT"},
        {"date": at(950), "category": "SafetyCar", "message": "VSC DEPLOYED"},
        {"date": at(960), "category": "SafetyCar", "message": "VSC ENDING"},
    ]
    assert status_periods(rows, start, 1000) == [
        {"kind": "SC", "start": 100, "end": 300},
        {"kind": "VSC", "start": 500, "end": 550},
        {"kind": "RED", "start": 700, "end": 900},
        {"kind": "VSC", "start": 950, "end": 960},
    ]


def test_positions_clamp_pre_race_rows_to_the_start():
    rows = [
        {"date": "2025-05-25T12:00:00+00:00", "position": 4},
        {"date": "2025-05-25T12:30:00+00:00", "position": 3},
        {"date": "2025-05-25T13:00:30+00:00", "position": 2},
        {"date": "2025-05-25T13:00:40+00:00", "position": 2},
    ]
    start = epoch("2025-05-25T13:00:00+00:00")
    assert _positions(rows, start) == [[0, 3], [30.0, 2]]


def test_pit_time_is_lane_entry_not_the_exit_timestamp():
    rows = [{"date": "2025-05-25T13:01:00+00:00", "lane_duration": 24.0, "stop_duration": 2.5, "lap_number": 5}]
    assert _pits(rows, epoch("2025-05-25T13:00:00+00:00"))[0]["t"] == 36.0


def test_stints_tolerate_a_zero_lap_end():
    rows = [{"lap_start": 20, "lap_end": 40, "compound": "HARD", "tyre_age_at_start": 0},
            {"lap_start": 1, "lap_end": 0, "compound": "MEDIUM", "tyre_age_at_start": 2}]
    assert [stint["compound"] for stint in _stints(rows)] == ["MEDIUM", "HARD"]


def test_slugs_keep_races_in_the_same_country_apart():
    assert slugify(2026, "Miami Grand Prix") != slugify(2026, "United States Grand Prix")
    assert slugify(2025, "São Paulo Grand Prix") == "2025-s-o-paulo-grand-prix"
