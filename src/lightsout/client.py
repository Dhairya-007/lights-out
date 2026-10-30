"""Small cached client for the free OpenF1 API (https://openf1.org)."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Callable

import requests

BASE_URL = "https://api.openf1.org/v1"
# Free tier allows 30 requests a minute, so stay just under that.
MIN_INTERVAL = 2.1
MAX_ATTEMPTS = 6
REQUEST_TIMEOUT = 60


class OpenF1Error(RuntimeError):
    pass


class OpenF1:
    def __init__(self, cache_dir: Path = Path(".cache/openf1"), session: requests.Session | None = None):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.http = session or requests.Session()
        self._last_call = 0.0

    def get(self, endpoint: str, cache: bool = True, **params: Any) -> list[dict]:
        if not cache:
            return self._fetch(endpoint, params)
        key = json.dumps([endpoint, sorted(params.items())], default=str)
        path = self.cache_dir / f"{endpoint}-{hashlib.sha1(key.encode()).hexdigest()[:16]}.json"
        if path.exists():
            return json.loads(path.read_text())
        rows = self._fetch(endpoint, params)
        path.write_text(json.dumps(rows))
        return rows

    def _fetch(self, endpoint: str, params: dict[str, Any]) -> list[dict]:
        for attempt in range(MAX_ATTEMPTS):
            wait = self._last_call + MIN_INTERVAL - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()
            try:
                response = self.http.get(f"{BASE_URL}/{endpoint}", params=params, timeout=REQUEST_TIMEOUT)
            except requests.RequestException:
                time.sleep(2**attempt)
                continue
            if response.status_code == 404:  # OpenF1's way of saying "no rows"
                return []
            if response.status_code == 429 or response.status_code >= 500:
                time.sleep(2**attempt)
                continue
            if response.status_code == 401:
                raise OpenF1Error(
                    "OpenF1 refused the request. Free access is paused while a live "
                    "session is running, so try again once it has finished."
                )
            response.raise_for_status()
            return response.json()
        raise OpenF1Error(f"Gave up on {endpoint} after {MAX_ATTEMPTS} attempts")


def download_race(api: OpenF1, session: dict, log: Callable[[str], None] = lambda _: None) -> dict:
    """Fetch every endpoint a replay needs for one race session."""
    key = session["session_key"]
    raw: dict[str, Any] = {"session": session}
    meeting = api.get("meetings", meeting_key=session["meeting_key"])
    raw["meeting_name"] = meeting[0]["meeting_name"] if meeting else None
    for endpoint in ("drivers", "laps", "stints", "pit", "position", "intervals",
                     "race_control", "session_result", "overtakes", "team_radio"):
        log(f"  {endpoint}")
        raw[endpoint] = api.get(endpoint, session_key=key)
    raw["location"], raw["car_data"] = {}, {}
    for index, driver in enumerate(raw["drivers"], 1):
        number = driver["driver_number"]
        log(f"  telemetry {index}/{len(raw['drivers'])}: {driver['name_acronym']}")
        raw["location"][number] = api.get("location", session_key=key, driver_number=number)
        raw["car_data"][number] = api.get("car_data", session_key=key, driver_number=number)
    return raw
