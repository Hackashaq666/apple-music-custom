#!/usr/bin/env python3
"""
Apple Music notification listener.
Listens for com.apple.iTunes.playerInfo distributed notifications
and POSTs to the local apple-music-api server so it can push
instant updates to Home Assistant via SSE.
"""

import json
import urllib.request
import urllib.error
import os
import sys

from Foundation import NSDistributedNotificationCenter, NSRunLoop, NSDate
import objc

SERVER_URL = os.environ.get("APPLE_MUSIC_API_URL", "http://localhost:8181")
NOTIFY_ENDPOINT = f"{SERVER_URL}/notify"


class MusicNotificationListener:
    def __init__(self):
        self.center = NSDistributedNotificationCenter.defaultCenter()
        self.center.addObserver_selector_name_object_(
            self,
            objc.selector(self.received_, signature=b"v@:@"),
            "com.apple.iTunes.playerInfo",
            None,
        )
        print(f"[notify] Listening for Music notifications -> {NOTIFY_ENDPOINT}", flush=True)

    def received_(self, notification):
        info = notification.userInfo()
        if not info:
            return

        payload = {
            "player_state":  info.get("Player State", ""),
            "name":          info.get("Name", ""),
            "artist":        info.get("Artist", ""),
            "album":         info.get("Album", ""),
            "total_time":    info.get("Total Time", 0),
            "persistent_id": str(info.get("PersistentID", "")),
        }

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            NOTIFY_ENDPOINT,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                pass
        except urllib.error.URLError as e:
            print(f"[notify] POST failed: {e}", flush=True)
        except Exception as e:
            print(f"[notify] Error: {e}", flush=True)


def main():
    listener = MusicNotificationListener()
    print("[notify] Running. Press Ctrl+C to stop.", flush=True)
    try:
        while True:
            NSRunLoop.currentRunLoop().runUntilDate_(
                NSDate.dateWithTimeIntervalSinceNow_(1)
            )
    except KeyboardInterrupt:
        print("[notify] Stopped.", flush=True)


if __name__ == "__main__":
    main()
