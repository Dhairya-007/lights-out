import json

import numpy as np

from lightsout.pack import outline_path, pack_frames, refresh, unpack_frames, write_replay


def replay():
    drivers = [
        {"num": number, "code": code, "name": code, "color": "#123456", "result": {"position": number},
         "x": [-3000, -2990, 4000], "y": [1200, 1210, -1500], "spd": [0, 320, 80],
         "thr": [0, 104, 40], "brk": [100, 0, 100], "gear": [1, 8, 2], "drs": [0, 1, 0]}
        for number, code in ((1, "AAA"), (2, "BBB"))
    ]
    return {"meta": {"slug": "2025-test", "date": "2025-01-01"}, "drivers": drivers, "moments": [],
            "track": {"x": [0, 500, 500, 0], "y": [0, 0, 250, 250]}}


def test_frames_survive_a_round_trip():
    drivers = replay()["drivers"]
    decoded = unpack_frames(pack_frames(drivers), drivers=2, frames=3)
    assert decoded["x"][1].tolist() == [-3000, -2990, 4000]
    assert decoded["spd"][0].tolist() == [0, 320, 80]
    assert decoded["gear"][0].tolist() == [1, 8, 2]


def test_throttle_glitches_above_100_are_clipped():
    drivers = replay()["drivers"]
    assert unpack_frames(pack_frames(drivers), 2, 3)["thr"][0].tolist() == [0, 100, 40]


def test_outline_fits_the_picker_box():
    path = outline_path({"x": [0, 500, 500, 0], "y": [0, 0, 250, 250]})
    numbers = np.array(path.replace("M", " ").replace("L", " ").replace("Z", " ").split(), float)
    assert numbers.min() >= 0 and numbers.max() <= 100


def test_refresh_packs_old_files_and_lists_them(tmp_path):
    (tmp_path / "2025-test.json").write_text(json.dumps(replay()))
    assert refresh(tmp_path) == 1
    race = json.loads((tmp_path / "2025-test.json").read_text())
    assert "x" not in race["drivers"][0] and race["frames"] == 3
    assert (tmp_path / "2025-test.frames.gz").exists()
    assert json.loads((tmp_path / "index.json").read_text())["races"][0]["winner"] == "AAA"


def test_write_replay_keeps_accents_readable(tmp_path):
    race = replay()
    race["meta"]["name"] = "São Paulo"
    path = write_replay(race, tmp_path)
    assert "São" in path.read_text()
