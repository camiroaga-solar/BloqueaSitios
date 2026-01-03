#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from typing import List, Optional


CONFIG_PATH_DEFAULT = "/Library/Application Support/BloqueaSitios/config.json"
STATE_PATH_DEFAULT = "/Library/Application Support/BloqueaSitios/state.json"
HOSTS_PATH = "/etc/hosts"
HOSTS_BEGIN = "# BEGIN BloqueaSitios (managed)"
HOSTS_END = "# END BloqueaSitios (managed)"

def _now_ms() -> int:
    return int(datetime.now().timestamp() * 1000)


def _clamp_int(v, default: int, min_v: int, max_v: int) -> int:
    try:
        n = int(v)
    except Exception:
        return default
    return max(min_v, min(max_v, n))


def _run(cmd: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, capture_output=True)


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError("Config must be a JSON object")
    return cfg


def _normalize_domain_entry(s: str) -> Optional[str]:
    s = str(s or "").strip().lower()
    if not s:
        return None
    # Strip scheme if user pasted URL
    s = re.sub(r"^https?://", "", s)
    # Strip path/query/fragment
    s = s.split("/", 1)[0]
    s = s.split("?", 1)[0]
    s = s.split("#", 1)[0]
    # Disallow wildcard/block-all here; hosts-based enforcement can’t do that safely.
    if s == "*" or s.startswith("*."):
        return None
    # Basic sanity: allow localhost/ip too, but most want real domains
    if " " in s or "\t" in s:
        return None
    return s


def _hosts_section_lines(blocked: List[str]) -> List[str]:
    lines = [HOSTS_BEGIN]
    for d in blocked:
        # Map to 0.0.0.0 to fail fast.
        lines.append(f"0.0.0.0 {d}")
        # Common extra: www.<domain>
        if not d.startswith("www.") and d.count(".") >= 1 and not re.match(r"^\d+\.\d+\.\d+\.\d+$", d):
            lines.append(f"0.0.0.0 www.{d}")
    lines.append(HOSTS_END)
    return lines


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _write_text_atomic(path: str, content: str) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)


def apply_hosts_state(should_block: bool, blocked_domains: List[str]) -> bool:
    """
    Returns True if /etc/hosts was changed.
    """
    original = _read_text(HOSTS_PATH)
    lines = original.splitlines()

    # Remove existing managed section if present
    out_lines: List[str] = []
    in_section = False
    for line in lines:
        if line.strip() == HOSTS_BEGIN:
            in_section = True
            continue
        if line.strip() == HOSTS_END:
            in_section = False
            continue
        if not in_section:
            out_lines.append(line)

    # Append managed section if blocking
    if should_block and blocked_domains:
        if out_lines and out_lines[-1].strip() != "":
            out_lines.append("")
        out_lines.extend(_hosts_section_lines(blocked_domains))
        out_lines.append("")

    new_text = "\n".join(out_lines).rstrip() + "\n"
    if new_text == original:
        return False
    _write_text_atomic(HOSTS_PATH, new_text)
    return True


def flush_dns_cache() -> None:
    # Best-effort; ignore failures.
    _run(["/usr/bin/dscacheutil", "-flushcache"])
    _run(["/usr/bin/killall", "-HUP", "mDNSResponder"])


def main(argv: List[str]) -> int:
    config_path = os.environ.get("BLOQUEASITIOS_CONFIG", CONFIG_PATH_DEFAULT)
    state_path = os.environ.get("BLOQUEASITIOS_STATE", STATE_PATH_DEFAULT)
    if len(argv) > 1:
        config_path = argv[1]
    if len(argv) > 2:
        state_path = argv[2]

    cfg = load_config(config_path)

    raw_blocked = cfg.get("blockedDomains") or []
    raw_allowed = cfg.get("allowedDomains") or []
    blocked = []
    for x in raw_blocked if isinstance(raw_blocked, list) else []:
        d = _normalize_domain_entry(x)
        if d:
            blocked.append(d)
    allowed = set()
    for x in raw_allowed if isinstance(raw_allowed, list) else []:
        d = _normalize_domain_entry(x)
        if d:
            allowed.add(d)
            allowed.add(f"www.{d}")

    # Apply allowlist as “remove from blocklist” (hosts-based approach can’t do true higher-priority allow rules).
    blocked = [d for d in blocked if d not in allowed and f"www.{d}" not in allowed]
    # Dedup, stable
    seen = set()
    blocked = [d for d in blocked if not (d in seen or seen.add(d))]

    # Read the decision from the probe (runs as the logged-in user and can access Calendar).
    try:
        state = load_config(state_path)
    except Exception as e:
        raise SystemExit(f"Failed to read state file at {state_path}: {e}")

    should_block = state.get("shouldBlock")
    if should_block is None:
        # Probe failed or hasn't run yet.
        last_error = state.get("lastError") or "probe returned shouldBlock=null"
        raise SystemExit(f"Probe not ready: {last_error}")
    should_block = bool(should_block)

    changed = apply_hosts_state(should_block, blocked)
    if changed:
        flush_dns_cache()

    # Exit codes: 0 ok, 2 config invalid is handled via SystemExit above.
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except SystemExit:
        raise
    except Exception as e:
        # launchd-friendly error
        sys.stderr.write(f"bloqueasitios_enforcer: {e}\n")
        raise SystemExit(1)


