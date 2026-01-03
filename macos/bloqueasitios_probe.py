#!/usr/bin/env python3
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Tuple


@dataclass(frozen=True)
class Window:
    start_ms: int
    end_ms: int


def _now_ms() -> int:
    return int(datetime.now().timestamp() * 1000)


def _clamp_int(v, default: int, min_v: int, max_v: int) -> int:
    try:
        n = int(v)
    except Exception:
        return default
    return max(min_v, min(max_v, n))


def _run(cmd: List[str], *, text: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, text=text, capture_output=True)


def _osascript(script: str) -> Tuple[int, str, str]:
    proc = _run(["/usr/bin/osascript", "-l", "AppleScript", "-e", script], text=True)
    return proc.returncode, proc.stdout, proc.stderr


def _escape_applescript_string(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _applescript_event_lines(calendar_name: str, start_dt: datetime, end_dt: datetime) -> str:
    cal = _escape_applescript_string(calendar_name)
    start_y, start_m, start_d = start_dt.year, start_dt.month, start_dt.day
    start_h, start_min, start_s = start_dt.hour, start_dt.minute, start_dt.second
    end_y, end_m, end_d = end_dt.year, end_dt.month, end_dt.day
    end_h, end_min, end_s = end_dt.hour, end_dt.minute, end_dt.second

    return f'''
on pad2(n)
  set s to (n as string)
  if (count of s) = 1 then return "0" & s
  return s
end pad2

on toEpochSeconds(d)
  set y to year of d as integer
  set m to month of d as integer
  set dd to day of d as integer
  set hh to hours of d as integer
  set mm to minutes of d as integer
  set ss to seconds of d as integer
  set stamp to (y as string) & "-" & pad2(m) & "-" & pad2(dd) & " " & pad2(hh) & ":" & pad2(mm) & ":" & pad2(ss)
  return do shell script "/bin/date -j -f '%Y-%m-%d %H:%M:%S' " & quoted form of stamp & " +%s"
end toEpochSeconds

set startD to current date
set year of startD to {start_y}
set month of startD to {start_m}
set day of startD to {start_d}
set hours of startD to {start_h}
set minutes of startD to {start_min}
set seconds of startD to {start_s}

set endD to current date
set year of endD to {end_y}
set month of endD to {end_m}
set day of endD to {end_d}
set hours of endD to {end_h}
set minutes of endD to {end_min}
set seconds of endD to {end_s}

tell application "Calendar"
  if not (exists calendar "{cal}") then
    error "Calendar not found: {cal}"
  end if

  tell calendar "{cal}"
    -- Include events that overlap the window (not just events starting inside it)
    set evs to every event whose end date is greater than startD and start date is less than endD
    repeat with e in evs
      try
        set isAllDay to false
        try
          set isAllDay to (all day event of e) as boolean
        end try
        set s to start date of e
        set t to end date of e
        set sEpoch to toEpochSeconds(s)
        set tEpoch to toEpochSeconds(t)
        do shell script "/bin/echo " & quoted form of (sEpoch & "|" & tEpoch & "|" & (isAllDay as string))
      end try
    end repeat
  end tell
end tell
'''


def fetch_windows(calendar_name: str, lookbehind_minutes: int, lookahead_days: int) -> List[Window]:
    now = datetime.now()
    start_dt = now - timedelta(minutes=lookbehind_minutes)
    end_dt = now + timedelta(days=lookahead_days)
    script = _applescript_event_lines(calendar_name, start_dt, end_dt)
    code, out, err = _osascript(script)
    if code != 0:
        raise RuntimeError((err or out or "").strip() or f"osascript failed with {code}")

    windows: List[Window] = []
    for raw in out.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.search(r"(\d+)\|(\d+)\|(\w+)$", line)
        if not m:
            continue
        start_s, end_s, all_day_s = m.group(1), m.group(2), m.group(3)
        if all_day_s.lower() in ("true", "yes"):
            continue
        try:
            start_ms = int(start_s) * 1000
            end_ms = int(end_s) * 1000
        except Exception:
            continue
        if end_ms <= start_ms:
            continue
        windows.append(Window(start_ms=start_ms, end_ms=end_ms))

    windows.sort(key=lambda w: w.start_ms)
    merged: List[Window] = []
    for w in windows:
        if not merged or w.start_ms > merged[-1].end_ms:
            merged.append(w)
        else:
            merged[-1] = Window(start_ms=merged[-1].start_ms, end_ms=max(merged[-1].end_ms, w.end_ms))
    return merged


def is_in_class(windows: List[Window], now_ms: int) -> bool:
    for w in windows:
        if now_ms >= w.start_ms and now_ms < w.end_ms:
            return True
    return False


def read_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        v = json.load(f)
    if not isinstance(v, dict):
        raise ValueError("JSON must be an object")
    return v


def write_json_atomic(path: str, obj: dict) -> None:
    import os
    import tempfile

    # Use /tmp for temp file since the target directory may be root-owned
    fd, tmp = tempfile.mkstemp(suffix=".json", prefix="bloqueasitios_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, sort_keys=True)
            f.write("\n")
        os.chmod(tmp, 0o666)  # Make world-readable so enforcer can read it
        os.replace(tmp, path)
    except Exception:
        # If atomic replace fails, write directly (state.json should be 666)
        try:
            os.unlink(tmp)
        except Exception:
            pass
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, sort_keys=True)
            f.write("\n")


def main(argv: List[str]) -> int:
    if len(argv) < 3:
        raise SystemExit("Usage: bloqueasitios_probe.py <config.json> <state.json>")
    config_path = argv[1]
    state_path = argv[2]

    cfg = read_json(config_path)
    calendar_name = str(cfg.get("calendarName") or "").strip()
    if not calendar_name:
        raise SystemExit("config.calendarName is required")

    behavior = str(cfg.get("behavior") or "block_when_not_in_class").strip()
    if behavior not in ("block_when_not_in_class", "block_when_in_class"):
        raise SystemExit("config.behavior must be 'block_when_not_in_class' or 'block_when_in_class'")

    lookahead_days = _clamp_int(cfg.get("lookaheadDays"), default=7, min_v=1, max_v=30)
    lookbehind_minutes = _clamp_int(cfg.get("lookbehindMinutes"), default=10, min_v=0, max_v=180)

    now_ms = _now_ms()
    out = {"updatedAtMs": now_ms}
    try:
        windows = fetch_windows(calendar_name, lookbehind_minutes, lookahead_days)
        in_class = is_in_class(windows, now_ms)
        should_block = (not in_class) if behavior == "block_when_not_in_class" else in_class
        out.update(
            {
                "ok": True,
                "calendarName": calendar_name,
                "inClass": in_class,
                "shouldBlock": should_block,
                "windowCount": len(windows),
                "lastError": None,
            }
        )
    except Exception as e:
        out.update({"ok": False, "calendarName": calendar_name, "inClass": None, "shouldBlock": None, "windowCount": 0, "lastError": str(e)})

    write_json_atomic(state_path, out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))


