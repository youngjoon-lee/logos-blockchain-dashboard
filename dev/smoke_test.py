"""End-to-end smoke test: synthetic logs + mock node API + the real dashboard.

Usage: python3 dev/smoke_test.py
Exits non-zero on the first failed check. Standard library only.
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAKE_NODE_KEY = "9f2c0d0b1a7e5f3c2d4b6a8e0f1c3d5b7a9e1f3c5d7b9a1e3f5c7d9b1a3e5f7c"  # from dev/gen_logs.py


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(port, path, raw=False):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=20) as r:
        body = r.read()
    return body if raw else json.loads(body)


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def wait_until(fn, what, timeout=90):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # server not up yet
            last = e
        time.sleep(1)
    check(False, "%s (last: %r)" % (what, last))


def main():
    tmp = tempfile.mkdtemp(prefix="lbd-smoke-")
    node_dir = os.path.join(tmp, "node1")
    api_port, dash_port = free_port(), free_port()
    procs = []
    try:
        subprocess.run([sys.executable, os.path.join(ROOT, "dev", "gen_logs.py"), node_dir, str(api_port)], check=True)
        procs.append(subprocess.Popen([sys.executable, os.path.join(ROOT, "dev", "mock_node.py"), str(api_port)]))
        procs.append(subprocess.Popen([
            sys.executable, os.path.join(ROOT, "dashboard.py"),
            "--data-dir", node_dir, "--host", "127.0.0.1", "--port", str(dash_port),
            "--db", os.path.join(tmp, "test.db"), "--poll", "1", "--metrics-cmd", "",
        ]))

        st = wait_until(lambda: (lambda s: s if s["blocks"].get("n") and s["events_total"] else None)(
            get(dash_port, "/api/status")), "dashboard collects blocks and log events")
        check(st["health"]["api_ok"], "node API reachable")
        dk = st.get("disk") or {}
        check(dk.get("db_bytes", 0) > 0 and dk.get("node_logs_bytes", 0) > 0 and dk.get("filesystems"),
              "disk usage reported (db %s bytes)" % dk.get("db_bytes"))
        check(st["log_files"] and all(f["name"].startswith("logos-blockchain.log") for f in st["log_files"]),
              "only the node's log files are parsed (%d files)" % len(st["log_files"]))
        wait_until(lambda: get(dash_port, "/api/status")["health"]["stream_connected"], "block stream connected")
        wait_until(lambda: get(dash_port, "/api/status")["health"]["backfill"].startswith("complete"),
                   "backfill completes")

        def tree_with_fork():
            t = get(dash_port, "/api/tree?window=1000")
            c = t["fields"].index("canonical")
            return t if any(n[c] == 0 for n in t["nodes"]) else None

        # The mock produces forks and reorgs only on the live stream.
        tree = wait_until(tree_with_fork, "block tree has fork blocks (from the live stream)")
        F = {f: i for i, f in enumerate(tree["fields"])}
        nodes = tree["nodes"]
        check(len(nodes) > 50, "block tree has blocks and forks (%d)" % len(nodes))
        check(all(n[F["height"]] is not None for n in nodes if n[F["canonical"]]), "canonical blocks have heights")
        check(tree["tip"] and tree["lib"], "tip and LIB known")

        tip = tree["tip"]
        blk = get(dash_port, "/api/block/" + tip)
        check(blk.get("block", {}).get("header", {}).get("id") == tip, "block detail for the tip")
        check(blk["meta"]["is_tip"] and blk["meta"]["canonical"], "tip flagged canonical")

        rows = get(dash_port, "/api/blocks")
        check(len(rows["rows"]) == st["blocks"]["n"] or len(rows["rows"]) > 50, "blocks endpoint rows")

        summary = get(dash_port, "/api/logsummary")
        kinds = {k["kind"] for k in summary["kinds"]}
        for kind in ("block_proposed", "pow_ticket", "ibd_start", "ibd_complete", "blend_conn_low",
                     "block_rejected", "epoch_transition", "recovery_done"):
            check(kind in kinds, "log rule matched: " + kind)
        ev = get(dash_port, "/api/events?kinds=blend_conn_low&limit=1")
        check(ev and ev[0]["fields"].get("wanted") == 6, "event fields extracted")

        phases = get(dash_port, "/api/phases")
        check([p[2] for p in phases["phase"]][:3] == ["IBD", "PBP", "Following"], "phase intervals from logs")

        cfg = get(dash_port, "/api/config")
        paths = [f["path"] for f in cfg["files"]]
        check(paths == ["deployment.yaml", "user_config.yaml"], "config lists only YAML files (%s)" % paths)
        text = get(dash_port, "/api/config?file=user_config.yaml")["content"]["text"]
        check("<hidden>" in text and FAKE_NODE_KEY not in text, "secret values are hidden")
        try:
            get(dash_port, "/api/config?file=../../etc/passwd")
            check(False, "non-listed file refused")
        except urllib.error.HTTPError as e:
            check(e.code == 400, "non-listed file refused")

        for path in ("/", "/app.js", "/plots.js", "/charts.js", "/style.css"):
            check(len(get(dash_port, path, raw=True)) > 1000, "static " + path)
        tail = get(dash_port, "/api/logtail?n=5")
        check(len(tail["lines"]) == 5 and "\x1b" not in "".join(tail["lines"]), "log tail without ANSI codes")
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
    print("all checks passed")


if __name__ == "__main__":
    main()
