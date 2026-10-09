"""The trace log: one JSON line per model call, tool call, HTTP round trip and decision.

Every line has a timestamp, the run number, the campaign, the step, what was called
with which arguments, the outcome, the latency, and tokens or search credits.
Secrets never appear: API keys and the app login token are not passed to this module.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path


class Trace:
    def __init__(self):
        self.run = None
        self.campaign = None
        self.step = 0
        self._buffer = []  # records written before the file name (run number) is known
        self._file = None
        self.path = None

    def open(self, path: Path, run_number) -> None:
        self.run = run_number
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._file = path.open("w", encoding="utf-8")
        for record in self._buffer:
            record.setdefault("run", run_number)
            self._write(record)
        self._buffer = []

    def rename(self, new_path: Path) -> None:
        if self._file:
            self._file.close()
            self._file = None
        if self.path and self.path.exists():
            new_path.parent.mkdir(parents=True, exist_ok=True)
            self.path.replace(new_path)
            self.path = new_path

    def close(self) -> None:
        if self._file:
            self._file.close()
            self._file = None

    def event(self, kind: str, **fields) -> dict:
        record = {
            "ts": datetime.now().astimezone().isoformat(timespec="milliseconds"),
            "run": self.run,
            "campaign": self.campaign,
            "step": self.step,
            "kind": kind,
        }
        record.update({k: v for k, v in fields.items() if v is not None})
        if self._file:
            self._write(record)
        else:
            self._buffer.append(record)
        return record

    def _write(self, record: dict) -> None:
        self._file.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        self._file.flush()


class Stopwatch:
    def __init__(self):
        self.start = time.monotonic()

    @property
    def ms(self) -> int:
        return int((time.monotonic() - self.start) * 1000)


def summarize(path: Path) -> dict:
    """Totals from a trace file: round trips and time per service, tokens, credits, outcomes."""
    trips = defaultdict(int)
    trip_ms = defaultdict(int)
    hosts = defaultdict(lambda: defaultdict(int))
    totals = defaultdict(int)
    tools = defaultdict(lambda: defaultdict(int))
    first_ts = last_ts = None
    run = None
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        run = r.get("run", run)
        ts = r.get("ts")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
        kind = r.get("kind")
        if kind == "http":
            service = r.get("service", "?")
            trips[service] += 1
            trip_ms[service] += int(r.get("latency_ms") or 0)
            hosts[service][r.get("host", "?")] += 1
        elif kind == "model":
            totals["model_calls"] += 1
            totals["tokens_in"] += int(r.get("tokens_in") or 0)
            totals["tokens_out"] += int(r.get("tokens_out") or 0)
        elif kind == "tool":
            tools[r.get("tool", "?")][r.get("status", "?")] += 1
            totals["credits"] += int(r.get("credits") or 0)
        elif kind == "retry":
            totals["retries"] += 1
            totals["retry_wait_ms"] += int(float(r.get("wait_s") or 0) * 1000)
    wall_ms = 0
    if first_ts and last_ts:
        wall_ms = int((datetime.fromisoformat(last_ts) - datetime.fromisoformat(first_ts)).total_seconds() * 1000)
    return {
        "run": run,
        "wall_ms": wall_ms,
        "round_trips": dict(trips),
        "round_trip_ms": dict(trip_ms),
        "hosts": {k: dict(v) for k, v in hosts.items()},
        "tools": {k: dict(v) for k, v in tools.items()},
        **totals,
    }


SERVICE_NAMES = {
    "model": "model API",
    "search": "search API (Tavily)",
    "fetch": "article sites",
    "robots": "robots.txt checks",
    "app": "CrowdCampaign API",
}


def format_summary(s: dict) -> str:
    lines = [f"Trace summary for run {s.get('run')}", ""]
    total_trips = sum(s["round_trips"].values())
    lines.append(f"Round trips: {total_trips} in total")
    for service, count in sorted(s["round_trips"].items(), key=lambda kv: -kv[1]):
        ms = s["round_trip_ms"].get(service, 0)
        top_hosts = ", ".join(f"{h} ({n})" for h, n in sorted(s["hosts"][service].items(), key=lambda kv: -kv[1])[:4])
        lines.append(f"  {SERVICE_NAMES.get(service, service):<22} {count:>4} trips  {ms / 1000:>7.1f} s   {top_hosts}")
    waited = s.get("retry_wait_ms", 0)
    if waited:
        lines.append(f"  {'waiting before retries':<22} {s.get('retries', 0):>4} waits  {waited / 1000:>7.1f} s")
    lines.append(f"Wall-clock time: {s['wall_ms'] / 1000:.1f} s")
    lines.append("")
    lines.append(f"Model calls: {s.get('model_calls', 0)}   tokens in: {s.get('tokens_in', 0):,}   tokens out: {s.get('tokens_out', 0):,}")
    lines.append(f"Search credits: {s.get('credits', 0)}")
    for tool, outcomes in sorted(s["tools"].items()):
        lines.append(f"  {tool:<14} " + ", ".join(f"{k}: {v}" for k, v in sorted(outcomes.items())))
    return "\n".join(lines)
