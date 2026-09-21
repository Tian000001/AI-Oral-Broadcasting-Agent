"""Probe/wait for a TCP port to become ready (used by start_app.bat).

Usage:
  python wait_port.py [port] [max_tries]
  - If port is omitted, defaults to 8080.
  - If max_tries is omitted, defaults to 40 (one probe per second).
  - Exits 0 if the port is reachable within max_tries, else 1.
"""
import socket
import sys
import time


def main() -> int:
    port = 8080
    tries = 40
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    if len(sys.argv) > 2:
        try:
            tries = int(sys.argv[2])
        except ValueError:
            pass

    sock = socket.socket()
    sock.settimeout(1)
    ok = False
    i = 0
    while i < tries and not ok:
        try:
            ok = sock.connect_ex(("127.0.0.1", port)) == 0
        except OSError:
            ok = False
        i += 1
        if not ok:
            time.sleep(1)
    sock.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
