"""Store car samples as delta-encoded binary, which loads far faster than JSON arrays."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np

# Two-byte columns come first so the browser can view them without realigning.
WIDE_COLUMNS = ("x", "y", "spd")
NARROW_COLUMNS = ("thr", "brk", "gear", "drs")
OUTLINE_POINTS = 72
OUTLINE_BOX = 100


def pack_frames(drivers: list[dict]) -> bytes:
    """Encode each column as the change from the previous sample, then gzip."""
    chunks = []
    for columns, dtype in ((WIDE_COLUMNS, "<i2"), (NARROW_COLUMNS, "i1")):
        for column in columns:
            for driver in drivers:
                values = np.array(driver[column], dtype=int)
                if column in ("thr", "brk"):
                    values = np.clip(values, 0, 100)
                chunks.append(np.diff(values, prepend=0).astype(dtype).tobytes())
    return gzip.compress(b"".join(chunks), compresslevel=9, mtime=0)


def unpack_frames(data: bytes, drivers: int, frames: int) -> dict[str, np.ndarray]:
    """Mirror of the decoder in web/app.js, kept here so the format stays tested."""
    raw, offset, result = gzip.decompress(data), 0, {}
    for columns, dtype, width in ((WIDE_COLUMNS, "<i2", 2), (NARROW_COLUMNS, "i1", 1)):
        for column in columns:
            size = drivers * frames
            deltas = np.frombuffer(raw, dtype, size, offset).reshape(drivers, frames)
            result[column] = deltas.cumsum(axis=1)
            offset += size * width
    return result


def write_replay(replay: dict, out: Path) -> Path:
    """Write a race as metadata JSON plus packed frames."""
    frames = pack_frames(replay["drivers"])
    meta = {
        **replay,
        "frames": len(replay["drivers"][0]["x"]),
        "drivers": [{key: value for key, value in driver.items()
                     if key not in WIDE_COLUMNS + NARROW_COLUMNS} for driver in replay["drivers"]],
    }
    path = out / f"{replay['meta']['slug']}.json"
    path.write_text(json.dumps(meta, separators=(",", ":"), ensure_ascii=False))
    path.with_suffix(".frames.gz").write_bytes(frames)
    return path


def outline_path(track: dict) -> str:
    """Shrink a circuit into an SVG path for the race picker."""
    x, y = np.array(track["x"], float), np.array(track["y"], float)
    picks = np.linspace(0, len(x) - 1, OUTLINE_POINTS).round().astype(int)
    x, y = x[picks], y[picks]
    scale = OUTLINE_BOX / max(np.ptp(x), np.ptp(y))
    left = (OUTLINE_BOX - np.ptp(x) * scale) / 2
    top = (OUTLINE_BOX - np.ptp(y) * scale) / 2
    points = zip(left + (x - x.min()) * scale, top + (y.max() - y) * scale)
    return "M" + "L".join(f"{px:.1f} {py:.1f}" for px, py in points) + "Z"


def _summary(race: dict) -> dict:
    winner = next((driver for driver in race["drivers"] if driver["result"].get("position") == 1), None)
    return {
        **race["meta"],
        "moments": len(race["moments"]),
        "winner": winner["name"] if winner else None,
        "winnerColor": winner["color"] if winner else None,
        "outline": outline_path(race["track"]),
    }


def refresh(out: Path) -> int:
    """Pack any race still in the old format, then rebuild index.json from the files on disk."""
    races = []
    for path in sorted(out.glob("2*.json")):
        race = json.loads(path.read_text())
        if "x" in race["drivers"][0]:
            write_replay(race, out)
            race = json.loads(path.read_text())
        races.append(_summary(race))
    races.sort(key=lambda race: race["date"], reverse=True)
    (out / "index.json").write_text(json.dumps({"races": races}, separators=(",", ":"), ensure_ascii=False))
    return len(races)
