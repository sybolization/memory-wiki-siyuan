"""Periodically snapshot both emulator servers so a server crash cannot lose progress."""
import json
import time
import urllib.request

SAVES = {8765: "autosave_map", 8766: "autosave_full"}
INTERVAL = 60
# A freshly booted server sits on the title/boot map. Saving immediately would
# overwrite the recovery state with that boot state before the agent has loaded
# the real one, so wait one long interval first.
STARTUP_DELAY = 150


def save(port: int, name: str) -> None:
    body = json.dumps({"name": name}).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/save",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        res.read()


time.sleep(STARTUP_DELAY)
while True:
    for port, name in SAVES.items():
        try:
            save(port, name)
        except Exception:
            pass
    time.sleep(INTERVAL)
