from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from lightsout.build import TRACK_POINTS, centerline

START = datetime(2025, 5, 25, 13, 0, tzinfo=timezone.utc)
LAP_SECONDS = 80.0
RADIUS = 800.0


def lap_rows(lap, glitch=None, dropout=None):
    """Rows for a car circling a hill, sampled at 4 Hz, in the feed's tenths of a metre."""
    rows = []
    for tick in range(int(LAP_SECONDS * 4) + 8):
        seconds = tick / 4 - 1
        if dropout and dropout[0] <= seconds <= dropout[1]:
            continue
        angle = 2 * np.pi * seconds / LAP_SECONDS
        z = 500 + 300 * np.sin(angle)
        if glitch is not None and tick == glitch:
            z = 0
        rows.append({
            "date": (START + timedelta(seconds=lap * LAP_SECONDS + seconds)).isoformat(),
            "x": RADIUS * 10 * np.cos(angle), "y": RADIUS * 10 * np.sin(angle), "z": z,
        })
    return rows


def lap_entry(lap, number=1):
    return {"driver_number": number, "lap_number": lap + 2, "lap_duration": LAP_SECONDS,
            "date_start": (START + timedelta(seconds=lap * LAP_SECONDS)).isoformat()}


def test_centerline_is_even_closed_and_keeps_elevation():
    rows = [row for lap in range(5) for row in lap_rows(lap)]
    track = centerline([lap_entry(lap) for lap in range(5)], {1: rows})
    x, y, z = (np.array(track[key]) for key in "xyz")
    assert len(x) == TRACK_POINTS
    steps = np.hypot(np.diff(x, append=x[0]), np.diff(y, append=y[0]))
    assert steps.max() < steps.mean() * 1.3
    assert abs(np.ptp(z) - 60) < 2


def test_centerline_ignores_a_glitched_lap():
    rows = [row for lap in range(5) for row in lap_rows(lap, glitch=100 if lap == 2 else None)]
    track = centerline([lap_entry(lap) for lap in range(5)], {1: rows})
    assert min(track["z"]) > 15


def test_laps_with_a_feed_dropout_are_skipped():
    laps = [lap_entry(0), lap_entry(1)]
    rows = lap_rows(0, dropout=(20, 30)) + lap_rows(1)
    assert centerline(laps, {1: rows})["laps"] == 1


def test_centerline_needs_at_least_one_usable_lap():
    with pytest.raises(ValueError):
        centerline([lap_entry(0)], {1: lap_rows(0, dropout=(20, 30))})
