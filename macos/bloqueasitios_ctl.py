#!/usr/bin/env python3
"""
CLI tool to manage BloqueaSitios config (add/remove/list domains).

Usage:
  bloqueasitios_ctl.py list                    # Show current blocked domains
  bloqueasitios_ctl.py add youtube.com         # Add domain to blocklist
  bloqueasitios_ctl.py remove youtube.com      # Remove domain from blocklist
  bloqueasitios_ctl.py add-common              # Add common distracting sites
  bloqueasitios_ctl.py status                  # Show current state (blocking or not)
  bloqueasitios_ctl.py set-calendar "Name"     # Set the calendar name
"""
import json
import os
import sys
from typing import List

CONFIG_PATH = "/Library/Application Support/BloqueaSitios/config.json"
STATE_PATH = "/Library/Application Support/BloqueaSitios/state.json"

# Common distracting sites - can be added with 'add-common'
COMMON_DISTRACTING_SITES = [
    "youtube.com",
    "reddit.com",
    "twitter.com",
    "x.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "netflix.com",
    "twitch.tv",
    "discord.com",
    "9gag.com",
    "imgur.com",
    "buzzfeed.com",
    "tumblr.com",
    "pinterest.com",
    "snapchat.com",
    "linkedin.com",
    "hulu.com",
    "disneyplus.com",
    "primevideo.com",
    "hbomax.com",
    "crunchyroll.com",
    "espn.com",
    "twitch.com",
]


def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        return {
            "calendarName": "",
            "behavior": "block_when_not_in_class",
            "lookaheadDays": 7,
            "lookbehindMinutes": 10,
            "blockedDomains": [],
            "allowedDomains": [],
        }
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    print(f"Saved to {CONFIG_PATH}")


def load_state() -> dict:
    if not os.path.exists(STATE_PATH):
        return {}
    with open(STATE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_domain(s: str) -> str:
    s = s.strip().lower()
    # Strip scheme
    if s.startswith("http://"):
        s = s[7:]
    if s.startswith("https://"):
        s = s[8:]
    # Strip path/query
    s = s.split("/", 1)[0]
    s = s.split("?", 1)[0]
    s = s.split("#", 1)[0]
    return s


def cmd_list(cfg: dict) -> None:
    blocked = cfg.get("blockedDomains") or []
    allowed = cfg.get("allowedDomains") or []
    calendar = cfg.get("calendarName") or "(not set)"

    print(f"Calendar: {calendar}")
    print(f"Behavior: {cfg.get('behavior', 'block_when_not_in_class')}")
    print()
    print(f"Blocked domains ({len(blocked)}):")
    if blocked:
        for d in sorted(blocked):
            print(f"  - {d}")
    else:
        print("  (none)")
    print()
    print(f"Allowed domains ({len(allowed)}):")
    if allowed:
        for d in sorted(allowed):
            print(f"  - {d}")
    else:
        print("  (none)")


def cmd_add(cfg: dict, domains: List[str]) -> None:
    blocked = cfg.get("blockedDomains") or []
    blocked_set = set(blocked)
    added = []
    for d in domains:
        d = normalize_domain(d)
        if not d or d == "*":
            print(f"Skipping invalid domain: {d}")
            continue
        if d not in blocked_set:
            blocked.append(d)
            blocked_set.add(d)
            added.append(d)
    cfg["blockedDomains"] = blocked
    save_config(cfg)
    if added:
        print(f"Added {len(added)} domain(s): {', '.join(added)}")
    else:
        print("No new domains added (already present or invalid)")


def cmd_remove(cfg: dict, domains: List[str]) -> None:
    blocked = cfg.get("blockedDomains") or []
    to_remove = {normalize_domain(d) for d in domains}
    new_blocked = [d for d in blocked if d not in to_remove]
    removed_count = len(blocked) - len(new_blocked)
    cfg["blockedDomains"] = new_blocked
    save_config(cfg)
    print(f"Removed {removed_count} domain(s)")


def cmd_add_common(cfg: dict) -> None:
    blocked = cfg.get("blockedDomains") or []
    blocked_set = set(blocked)
    added = []
    for d in COMMON_DISTRACTING_SITES:
        if d not in blocked_set:
            blocked.append(d)
            blocked_set.add(d)
            added.append(d)
    cfg["blockedDomains"] = blocked
    save_config(cfg)
    print(f"Added {len(added)} common distracting sites")
    if added:
        for d in added:
            print(f"  + {d}")


def cmd_status() -> None:
    state = load_state()
    cfg = load_config()

    if not state:
        print("Status: No state file (probe hasn't run yet)")
        return

    ok = state.get("ok")
    in_class = state.get("inClass")
    should_block = state.get("shouldBlock")
    last_error = state.get("lastError")
    calendar = state.get("calendarName") or cfg.get("calendarName") or "(not set)"

    print(f"Calendar: {calendar}")
    if not ok:
        print(f"Status: ERROR - {last_error}")
        return

    if in_class:
        print("Status: IN CLASS - sites are UNBLOCKED")
    else:
        print("Status: NOT IN CLASS - sites are BLOCKED")

    print(f"shouldBlock = {should_block}")


def cmd_set_calendar(cfg: dict, name: str) -> None:
    cfg["calendarName"] = name
    save_config(cfg)
    print(f"Calendar set to: {name}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    cmd = sys.argv[1].lower()
    cfg = load_config()

    if cmd == "list":
        cmd_list(cfg)
    elif cmd == "add":
        if len(sys.argv) < 3:
            print("Usage: bloqueasitios_ctl.py add <domain> [domain2] ...")
            return 1
        cmd_add(cfg, sys.argv[2:])
    elif cmd == "remove" or cmd == "rm":
        if len(sys.argv) < 3:
            print("Usage: bloqueasitios_ctl.py remove <domain> [domain2] ...")
            return 1
        cmd_remove(cfg, sys.argv[2:])
    elif cmd == "add-common":
        cmd_add_common(cfg)
    elif cmd == "status":
        cmd_status()
    elif cmd == "set-calendar":
        if len(sys.argv) < 3:
            print("Usage: bloqueasitios_ctl.py set-calendar <CalendarName>")
            return 1
        cmd_set_calendar(cfg, sys.argv[2])
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
