#!/usr/bin/env python3
"""Logos blockchain node dashboard.

Runs next to a node started by logosctl, collects everything it can find about
the node into a local SQLite database, and serves a web UI.

Sources:
  * the node HTTP API (default 127.0.0.1:8080, read from user_config.yaml):
      - /cryptarchia/events/blocks/stream  every processed block, forks included
      - /cryptarchia/blocks_range          canonical history backfill
      - /cryptarchia/info, /time/info, /network/info, /blend/info, /pow/status
  * the node log files under <data-dir>/logs (plain, rotated and .gz)
  * the config files under <data-dir>

Only the Python 3 standard library is used.
"""

import argparse
import glob
import gzip
import http.server
import json
import mimetypes
import os
import re
import shutil
import socketserver
import subprocess
import sqlite3
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zlib

from logrules import RULES, categorize_target, rules_version

PARSER_VERSION = 2

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

HEX64 = re.compile(r"[0-9a-f]{64}")

# Best known time the node processed a block: its own log line when DEBUG is on,
# else when the dashboard received the block from the node's push stream.
T_MS = "coalesce(bt.applied_ms, bt.received_ms, b.seen_ms)"
T_SRC = "CASE WHEN bt.applied_ms IS NOT NULL THEN 'applied' WHEN bt.received_ms IS NOT NULL THEN 'received' " \
        "WHEN b.seen_ms IS NOT NULL THEN 'stream' END"
JOIN_T = "blocks b LEFT JOIN block_times bt ON bt.id = b.id"


def now_ms():
    return int(time.time() * 1000)


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    parent TEXT,
    slot INTEGER,
    height INTEGER,
    seen_ms INTEGER,          -- when the dashboard saw it on the live stream
    source TEXT,              -- stream | backfill | api
    tx_count INTEGER,
    uncle_count INTEGER,
    tip_at_seen TEXT,
    lib_at_seen TEXT,
    json TEXT
);
CREATE INDEX IF NOT EXISTS blocks_parent ON blocks(parent);
CREATE INDEX IF NOT EXISTS blocks_slot ON blocks(slot);
CREATE INDEX IF NOT EXISTS blocks_height ON blocks(height);

CREATE TABLE IF NOT EXISTS chain_events (   -- tip / LIB changes seen live
    ts INTEGER, kind TEXT, old TEXT, new TEXT, slot INTEGER, depth INTEGER
);
CREATE INDEX IF NOT EXISTS chain_events_ts ON chain_events(ts);

CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER, name TEXT, value REAL
);
CREATE INDEX IF NOT EXISTS samples_name_ts ON samples(name, ts);

CREATE TABLE IF NOT EXISTS snapshots (
    name TEXT PRIMARY KEY, ts INTEGER, json TEXT
);

CREATE TABLE IF NOT EXISTS events (
    ts INTEGER, level TEXT, target TEXT, category TEXT, kind TEXT,
    msg TEXT, fields TEXT, file TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);
CREATE INDEX IF NOT EXISTS events_cat_ts ON events(category, ts);

CREATE TABLE IF NOT EXISTS log_stats (       -- per-minute line counts, per log file
    minute INTEGER, level TEXT, category TEXT, file TEXT, n INTEGER,
    PRIMARY KEY (minute, level, category, file)
);

CREATE TABLE IF NOT EXISTS templates (       -- normalized message counts, per log file
    template TEXT, file TEXT, level TEXT, target TEXT, n INTEGER,
    first_ts INTEGER, last_ts INTEGER, example TEXT,
    PRIMARY KEY (template, file)
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT
);

CREATE TABLE IF NOT EXISTS log_files (
    name TEXT PRIMARY KEY, offset INTEGER, done INTEGER
);

CREATE TABLE IF NOT EXISTS block_times (     -- exact node times from DEBUG log lines
    id TEXT PRIMARY KEY,
    received_ms INTEGER,      -- chain::service "Received proposal": processing started
    applied_ms INTEGER        -- chain::network "block applied": apply finished
);

CREATE TABLE IF NOT EXISTS anchors (         -- known (block, height) pairs
    id TEXT PRIMARY KEY, height INTEGER
);
"""


class DB:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.local = threading.local()
        with self.conn() as c:
            # log_stats/templates gained a per-file key: old copies are rebuilt
            # from the log files.
            old = {r[1] for r in c.execute("PRAGMA table_info(log_stats)")}
            if old and "file" not in old:
                c.executescript("DROP TABLE log_stats; DROP TABLE templates; DELETE FROM log_files;")
            c.executescript(SCHEMA)
            cols = {r[1] for r in c.execute("PRAGMA table_info(blocks)")}
            for col, typ in (("ops", "TEXT"), ("size", "INTEGER")):
                if col not in cols:
                    c.execute("ALTER TABLE blocks ADD COLUMN %s %s" % (col, typ))

    def conn(self):
        c = getattr(self.local, "c", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=60)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_size_limit=33554432")
            self.local.c = c
        return c

    def q(self, sql, args=()):
        return self.conn().execute(sql, args).fetchall()

    def one(self, sql, args=()):
        r = self.conn().execute(sql, args).fetchone()
        return r

    def meta(self, key, default=None):
        r = self.one("SELECT value FROM meta WHERE key=?", (key,))
        return r[0] if r else default

    def write(self, fn):
        with self.lock:
            c = self.conn()
            try:
                out = fn(c)
                c.commit()
                return out
            except Exception:
                c.rollback()
                raise


def pack_block(block):
    raw = json.dumps(block, separators=(",", ":")).encode()
    return zlib.compress(raw, 6), len(raw)


def unpack_block(value):
    if value is None:
        return None
    if isinstance(value, bytes):
        value = zlib.decompress(value)
    return json.loads(value)


def op_counts(block):
    """{opcode: count} over every transaction of a block."""
    out = {}
    for tx in block.get("transactions") or []:
        mtx = tx.get("mantle_tx") if isinstance(tx, dict) else None
        for op in (mtx or {}).get("ops") or []:
            code = str(op.get("opcode"))
            out[code] = out.get(code, 0) + 1
    return out


# --------------------------------------------------------------------------
# Node API client
# --------------------------------------------------------------------------


class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def get(self, path, timeout=10):
        with urllib.request.urlopen(self.base + path, timeout=timeout) as r:
            body = r.read()
        return json.loads(body) if body else None

    def stream(self, path, timeout=600):
        r = urllib.request.urlopen(self.base + path, timeout=timeout)
        return r


# --------------------------------------------------------------------------
# Blocks: storage, heights, tree
# --------------------------------------------------------------------------


class Chain:
    def __init__(self, db):
        self.db = db
        self.tip = None
        self.lib = None
        self.lib_slot = None
        self.canon_cache = (None, set())

    def store_block(self, c, block, source, seen_ms=None, tip=None, lib=None):
        h = block.get("header") or {}
        bid = h.get("id")
        if not bid:
            return False
        parent = h.get("parent_block")
        slot = h.get("slot")
        txs = block.get("transactions") or []
        uncles = block.get("uncle_headers") or []
        row = c.execute("SELECT seen_ms, source FROM blocks WHERE id=?", (bid,)).fetchone()
        if row is None:
            packed, size = pack_block(block)
            c.execute(
                "INSERT INTO blocks(id,parent,slot,seen_ms,source,tx_count,uncle_count,tip_at_seen,lib_at_seen,json,ops,size)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (bid, parent, slot, seen_ms, source, len(txs), len(uncles), tip, lib, packed,
                 json.dumps(op_counts(block)), size),
            )
            ph = c.execute("SELECT height FROM blocks WHERE id=?", (parent,)).fetchone()
            if ph and ph[0] is not None:
                self.assign_height(c, bid, ph[0] + 1)
            else:
                # Maybe a child arrived first (backfill order) or this is an anchor.
                a = c.execute("SELECT height FROM anchors WHERE id=?", (bid,)).fetchone()
                if a:
                    self.assign_height(c, bid, a[0])
                else:
                    ch = c.execute(
                        "SELECT height FROM blocks WHERE parent=? AND height IS NOT NULL LIMIT 1", (bid,)
                    ).fetchone()
                    if ch:
                        self.assign_height(c, bid, ch[0] - 1)
            return True
        if seen_ms is not None and row["seen_ms"] is None:
            c.execute(
                "UPDATE blocks SET seen_ms=?, tip_at_seen=?, lib_at_seen=? WHERE id=?",
                (seen_ms, tip, lib, bid),
            )
        return False

    def assign_height(self, c, bid, height):
        """Set a height and propagate it to every connected block lacking one."""
        stack = [(bid, height)]
        while stack:
            b, hgt = stack.pop()
            r = c.execute("SELECT height, parent FROM blocks WHERE id=?", (b,)).fetchone()
            if r is None or r[0] is not None:
                continue
            c.execute("UPDATE blocks SET height=? WHERE id=?", (hgt, b))
            if r[1]:
                stack.append((r[1], hgt - 1))
            for (child,) in c.execute("SELECT id FROM blocks WHERE parent=? AND height IS NULL", (b,)):
                stack.append((child, hgt + 1))

    def add_anchor(self, c, bid, height):
        c.execute("INSERT OR REPLACE INTO anchors(id,height) VALUES(?,?)", (bid, height))
        r = c.execute("SELECT height FROM blocks WHERE id=?", (bid,)).fetchone()
        if r is not None and r[0] is None:
            self.assign_height(c, bid, height)

    def canonical(self, tip=None):
        tip = tip or self.tip
        if not tip:
            return set()
        if self.canon_cache[0] == tip:
            return self.canon_cache[1]
        rows = self.db.q("SELECT id, parent FROM blocks")
        parent = {r[0]: r[1] for r in rows}
        out = set()
        cur = tip
        while cur in parent and cur not in out:
            out.add(cur)
            cur = parent[cur]
        self.canon_cache = (tip, out)
        return out

    def fork_depths(self, c, old, new, limit=5000):
        """(blocks from old to the common ancestor, blocks from new to it),
        or None if no common ancestor is stored within `limit` blocks."""
        anc = {}
        cur, d = new, 0
        while cur and d < limit:
            anc[cur] = d
            r = c.execute("SELECT parent FROM blocks WHERE id=?", (cur,)).fetchone()
            cur = r[0] if r else None
            d += 1
        cur, d = old, 0
        while cur and d < limit:
            if cur in anc:
                return d, anc[cur]
            r = c.execute("SELECT parent FROM blocks WHERE id=?", (cur,)).fetchone()
            cur = r[0] if r else None
            d += 1
        return None

    def observe_tip_lib(self, c, tip, tip_slot, lib, lib_slot, ts):
        # Judge a tip change only once its block is stored; the stream
        # delivers it shortly if a poll saw the new tip first.
        known = tip and c.execute("SELECT 1 FROM blocks WHERE id=?", (tip,)).fetchone()
        if known and tip != self.tip:
            depths = self.fork_depths(c, self.tip, tip) if self.tip else None
            if depths and depths[1] == 0:
                pass  # an ancestor of the current tip: a stale observation
            else:
                if self.tip is not None:
                    reorg = depths is not None and depths[0] > 0
                    c.execute(
                        "INSERT INTO chain_events(ts,kind,old,new,slot,depth) VALUES(?,?,?,?,?,?)",
                        (ts, "reorg" if reorg else "tip", self.tip, tip, tip_slot, depths[0] if reorg else 0),
                    )
                self.tip = tip
        if lib and lib != self.lib and (self.lib_slot is None or lib_slot is None or lib_slot >= self.lib_slot):
            if self.lib is not None:
                c.execute(
                    "INSERT INTO chain_events(ts,kind,old,new,slot,depth) VALUES(?,?,?,?,?,?)",
                    (ts, "lib", self.lib, lib, lib_slot, None),
                )
            self.lib = lib
            self.lib_slot = lib_slot


# --------------------------------------------------------------------------
# Collectors
# --------------------------------------------------------------------------


class Collector:
    def __init__(self, db, api, chain, logs_dir, log_prefix, poll_interval, metrics_cmd, keep_block_json=2000):
        self.keep_block_json = keep_block_json
        self.log_prefix = log_prefix
        self.metrics_cmd = metrics_cmd
        self.db = db
        self.api = api
        self.chain = chain
        self.logs_dir = logs_dir
        self.poll_interval = poll_interval
        self.health = {
            "stream_connected": False,
            "stream_last_event_ms": None,
            "stream_error": None,
            "api_ok": False,
            "api_error": None,
            "backfill": None,
            "logs_last_scan_ms": None,
            "logs_error": None,
            "metrics": None,
        }
        self.backfill_lock = threading.Lock()
        self.dead_gaps = set()

    def start(self):
        rebuild_logs_if_rules_changed(self.db, self.logs_dir, self.log_prefix)
        for fn in (self.block_stream_loop, self.poll_loop, self.log_loop, self.backfill_loop, self.metrics_loop,
                   self.maintenance_loop):
            threading.Thread(target=self.guard(fn), daemon=True, name=fn.__name__).start()

    @staticmethod
    def guard(fn):
        def run():
            while True:
                try:
                    fn()
                except Exception:
                    traceback.print_exc()
                time.sleep(5)

        return run

    # ---- live block stream -------------------------------------------------

    def block_stream_loop(self):
        try:
            resp = self.api.stream("/cryptarchia/events/blocks/stream", timeout=900)
        except Exception as e:
            self.health.update(stream_connected=False, stream_error=str(e))
            time.sleep(10)
            return
        self.health.update(stream_connected=True, stream_error=None)
        log("block stream connected")
        first = True
        try:
            for line in resp:
                line = line.strip()
                if not line:
                    continue
                ev = json.loads(line)
                ts = now_ms()
                block = ev.get("block") or {}
                bid = (block.get("header") or {}).get("id")

                def w(c):
                    exists = c.execute("SELECT 1 FROM blocks WHERE id=?", (bid,)).fetchone()
                    # The first event after subscribing may be a snapshot of the
                    # current tip rather than a freshly processed block.
                    seen = None if (first and exists) else ts
                    self.chain.store_block(c, block, "stream", seen, ev.get("tip"), ev.get("lib"))
                    self.chain.observe_tip_lib(
                        c, ev.get("tip"), ev.get("tip_slot"), ev.get("lib"), ev.get("lib_slot"), ts
                    )

                self.db.write(w)
                first = False
                self.health["stream_last_event_ms"] = ts
        finally:
            self.health["stream_connected"] = False
            resp.close()

    # ---- canonical backfill -------------------------------------------------

    def backfill_loop(self):
        """Pull canonical blocks the dashboard has not seen, newest first,
        until the history is complete down to genesis."""
        while self.backfill_once():
            time.sleep(1)
        time.sleep(300)

    def backfill_once(self, limit=5000):
        """Fetch the canonical blocks below the newest gap (a stored block
        whose parent is not stored), or the newest blocks if nothing is
        stored yet. Returns how many new blocks were stored."""
        with self.backfill_lock:
            try:
                info = self.api.get("/cryptarchia/info")["cryptarchia_info"]
            except Exception as e:
                self.health["backfill"] = "waiting for API: %s" % e
                return 0
            if self.db.one("SELECT 1 FROM blocks LIMIT 1") is None:
                targets = [info["slot"]]
            else:
                targets = [r[0] for r in self.db.q(
                    "SELECT DISTINCT b.slot - 1 FROM blocks b LEFT JOIN blocks p ON p.id = b.parent"
                    " WHERE p.id IS NULL AND b.slot > 0 ORDER BY b.slot DESC LIMIT 20"
                )]
            if not targets:
                self.health["backfill"] = "complete"
                return 0
            for slot_to in targets:
                if slot_to in self.dead_gaps:
                    continue
                n = self.fetch_range(slot_to, limit)
                if n is None:
                    return 0
                if n:
                    self.health["backfill"] = "fetched %d blocks below slot %d at %s" % (
                        n, slot_to + 1, time.strftime("%H:%M:%S"))
                    log("backfill stored", n, "blocks below slot", slot_to + 1)
                    return n
                # Nothing new below this gap: an orphan or pruned fork parent.
                self.dead_gaps.add(slot_to)
            self.health["backfill"] = "complete (%d unresolvable gaps)" % len(self.dead_gaps)
            return 0

    def fetch_range(self, slot_to, limit):
        q = urllib.parse.urlencode(
            {"order": "descending", "blocks_limit": limit, "slot_to": slot_to, "slot_from": 0, "server_batch_size": 500}
        )
        self.health["backfill"] = "running (below slot %s)" % (slot_to + 1)
        n = 0
        try:
            resp = self.api.stream("/cryptarchia/blocks_range?" + q, timeout=300)
            batch = []
            for line in resp:
                line = line.strip()
                if not line:
                    continue
                batch.append(json.loads(line))
                if len(batch) >= 200:
                    n += self.store_backfill(batch)
                    batch = []
            n += self.store_backfill(batch)
            resp.close()
        except Exception as e:
            self.health["backfill"] = "error: %s" % e
            return None
        return n

    def store_backfill(self, batch):
        def w(c):
            k = 0
            for ev in batch:
                if self.chain.store_block(c, ev.get("block") or {}, "backfill"):
                    k += 1
            return k

        return self.db.write(w) if batch else 0

    # ---- periodic polling ---------------------------------------------------

    POLLS = [
        ("cryptarchia", "/cryptarchia/info"),
        ("time", "/time/info"),
        ("network", "/network/info"),
        ("blend", "/blend/info"),
        ("pow", "/pow/status"),
        ("version", "/version"),
        ("mempool", "/mempool/view"),
    ]

    def poll_loop(self):
        tick = 0
        while True:
            ts = now_ms()
            results = {}
            ok = False
            online = None
            for name, path in self.POLLS:
                if name in ("version",) and tick % 60:
                    continue
                # The PoW service answers only once the chain is online;
                # before that its requests hang until the timeout.
                if name == "pow" and online is False:
                    results[name] = {"_error": "PoW service starts when the chain is online"}
                    continue
                try:
                    results[name] = self.api.get(path, timeout=10)
                    ok = True
                    if name == "cryptarchia":
                        online = str(results[name]["cryptarchia_info"].get("state", "")).lower() == "online"
                except urllib.error.HTTPError as e:
                    results[name] = {"_error": "HTTP %s" % e.code}
                except Exception as e:
                    results[name] = {"_error": str(e)}
            self.health["api_ok"] = ok
            self.health["api_error"] = None if ok else results.get("cryptarchia", {}).get("_error")

            def w(c):
                for name, val in results.items():
                    c.execute(
                        "INSERT OR REPLACE INTO snapshots(name,ts,json) VALUES(?,?,?)",
                        (name, ts, json.dumps(val)),
                    )
                    if isinstance(val, dict) and "_error" in val:
                        continue
                    for k, v in flatten_numbers(name, val):
                        c.execute("INSERT INTO samples(ts,name,value) VALUES(?,?,?)", (ts, k, v))
                ci = results.get("cryptarchia")
                if isinstance(ci, dict) and "cryptarchia_info" in ci:
                    info = ci["cryptarchia_info"]
                    self.chain.add_anchor(c, info["tip"], info["height"])
                    # The stream reports tip/LIB after every block in processing
                    # order; polls race with it and would record phantom reorgs.
                    # Use them only while the stream is down.
                    if not self.health["stream_connected"]:
                        self.chain.observe_tip_lib(c, info["tip"], info["slot"], info["lib"], info["lib_slot"], ts)
                    c.execute(
                        "INSERT INTO samples(ts,name,value) VALUES(?,?,?)",
                        (ts, "cryptarchia.phase_code", PHASES.get(ci.get("phase"), -1)),
                    )
                    c.execute(
                        "INSERT INTO samples(ts,name,value) VALUES(?,?,?)",
                        (ts, "cryptarchia.online", 1 if str(info.get("state", "")).lower() == "online" else 0),
                    )
                ti = results.get("time")
                if isinstance(ci, dict) and "cryptarchia_info" in ci and isinstance(ti, dict) and "current_slot" in ti:
                    c.execute(
                        "INSERT INTO samples(ts,name,value) VALUES(?,?,?)",
                        (ts, "cryptarchia.slots_behind", ti["current_slot"] - ci["cryptarchia_info"]["slot"]),
                    )
                    c.execute(
                        "INSERT INTO samples(ts,name,value) VALUES(?,?,?)",
                        (ts, "cryptarchia.tip_minus_lib_slots", ci["cryptarchia_info"]["slot"] - ci["cryptarchia_info"]["lib_slot"]),
                    )

            self.db.write(w)
            tick += 1
            time.sleep(self.poll_interval)

    # ---- storage maintenance ------------------------------------------------

    def maintenance_loop(self):
        """Compress legacy rows, then drop the JSON of old canonical blocks
        (the node serves those on demand). Fork blocks keep their JSON: the
        node prunes them, so the dashboard's copy is the only one left."""
        while True:
            rows = self.db.q("SELECT id, json FROM blocks WHERE ops IS NULL AND json IS NOT NULL LIMIT 500")
            if not rows:
                break

            def w(c, rows=rows):
                for bid, raw in rows:
                    block = unpack_block(raw)
                    packed, size = pack_block(block)
                    c.execute("UPDATE blocks SET json=?, ops=?, size=? WHERE id=?",
                              (packed, json.dumps(op_counts(block)), size, bid))

            self.db.write(w)
        freed = 0
        if self.keep_block_json:
            top = self.db.one("SELECT max(height) FROM blocks")[0]
            if top is not None:
                canon = self.chain.canonical()
                old = [r[0] for r in self.db.q(
                    "SELECT id FROM blocks WHERE json IS NOT NULL AND height < ?", (top - self.keep_block_json,))
                    if r[0] in canon]
                for i in range(0, len(old), 500):
                    chunk = old[i:i + 500]
                    self.db.write(lambda c, chunk=chunk: c.executemany(
                        "UPDATE blocks SET json=NULL WHERE id=?", [(b,) for b in chunk]))
                freed = len(old)
        page = self.db.one("PRAGMA page_size")[0]
        free = self.db.one("PRAGMA freelist_count")[0] * page
        if free > 64 * 1024 * 1024:
            log("vacuum: %.0f MB free in the database" % (free / 1048576))
            try:
                with self.db.lock:
                    self.db.conn().execute("VACUUM")
            except sqlite3.OperationalError as e:
                log("vacuum skipped:", e)
        if freed:
            log("dropped JSON of %d old canonical blocks" % freed)
        try:
            with self.db.lock:
                self.db.conn().execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.OperationalError:
            pass
        time.sleep(600)

    # ---- OpenMetrics via logosctl (optional) -----------------------------------

    def metrics_loop(self):
        """The node only exposes OpenMetrics through the C bindings, so ask
        logosctl for it. Needs `tracing.metrics.enable_open_metrics: true`."""
        if not self.metrics_cmd:
            self.health["metrics"] = "disabled (logosctl not found; see --metrics-cmd)"
            time.sleep(3600)
            return
        try:
            out = subprocess.run(self.metrics_cmd, shell=True, capture_output=True, timeout=30, text=True)
        except Exception as e:
            self.health["metrics"] = "error: %s" % e
            time.sleep(300)
            return
        text = out.stdout
        try:
            j = json.loads(text)
            res = j.get("result", j) if isinstance(j, dict) else j
            if isinstance(res, dict):
                if res.get("success") is False:
                    self.health["metrics"] = "unavailable: %s" % (res.get("error") or "unknown error")
                    time.sleep(300)
                    return
                text = res.get("value", "")
            elif isinstance(res, str):
                text = res
        except ValueError:
            pass
        samples = parse_open_metrics(text)
        if not samples:
            self.health["metrics"] = "no samples (exit %s): %s" % (out.returncode, (out.stderr or text)[:200])
            time.sleep(300)
            return
        ts = now_ms()

        def w(c):
            c.executemany("INSERT INTO samples(ts,name,value) VALUES(?,?,?)", [(ts, k, v) for k, v in samples])

        self.db.write(w)
        self.health["metrics"] = "ok · %d series · %s" % (len(samples), time.strftime("%H:%M:%S"))
        time.sleep(15)

    # ---- logs ---------------------------------------------------------------

    def log_loop(self):
        while True:
            try:
                scan_logs(self.db, self.logs_dir, self.log_prefix)
                self.health["logs_error"] = None
            except Exception as e:
                self.health["logs_error"] = str(e)
                traceback.print_exc()
            self.health["logs_last_scan_ms"] = now_ms()
            time.sleep(10)


OM_LINE = re.compile(r"^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)")


def parse_open_metrics(text):
    out = []
    for line in (text or "").splitlines():
        if not line or line.startswith("#"):
            continue
        m = OM_LINE.match(line)
        if not m:
            continue
        name, labels, val = m.groups()
        if name.endswith("_bucket") or name.endswith("_created"):
            continue
        labels = re.sub(r",?(otel_scope_\w+|service_name|job|instance)=\"[^\"]*\"", "", labels or "").replace("{,", "{")
        if labels == "{}":
            labels = ""
        try:
            out.append(("metrics." + name + labels, float(val)))
        except ValueError:
            pass
    return out


PHASES = {"AwaitingGenesisTime": 0, "InitialBlockDownload": 1, "ProlongedBootstrapPeriod": 2, "Following": 3}


def flatten_numbers(prefix, val, depth=0):
    out = []
    if depth > 4:
        return out
    if isinstance(val, bool):
        out.append((prefix, 1.0 if val else 0.0))
    elif isinstance(val, (int, float)):
        out.append((prefix, float(val)))
    elif isinstance(val, dict):
        for k, v in val.items():
            out.extend(flatten_numbers(prefix + "." + str(k), v, depth + 1))
    elif isinstance(val, list):
        out.append((prefix + ".len", float(len(val))))
    return out


# --------------------------------------------------------------------------
# Log parsing
# --------------------------------------------------------------------------

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
LINE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+"
    r"(?P<level>TRACE|DEBUG|INFO|WARN|ERROR)\s+(?P<rest>.*)$"
)
# Spans (`name{a=b}:`) may precede the target. Every span in the node carries
# fields, which tells them apart from the `target:` that follows.
SPANS = re.compile(r"^(?:[\w-]+\{[^}]*\}:)+\s*")
TARGET = re.compile(r"^(?P<target>[A-Za-z_][\w-]*(?:::[\w-]+)*): (?P<msg>.*)$", re.S)
KV = re.compile(r"(?<![\w.])([a-zA-Z_][\w.]*)=(\"(?:[^\"\\]|\\.)*\"|\[[^\]]*\]|\{[^}]*\}|[^\s,]+)")
NORMALIZE = [
    (re.compile(r"[0-9a-f]{16,}"), "<hex>"),
    (re.compile(r"12D3Koo\w+"), "<peer>"),
    (re.compile(r"/ip[46]/\S+"), "<addr>"),
    (re.compile(r"\b\d+(\.\d+)?(ms|s|µs|ns)?\b"), "<n>"),
]


def parse_ts(s):
    import datetime

    s = s.replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # Python < 3.11 fromisoformat only takes up to 6 fractional digits.
    m = re.match(r"^(.*\.\d{6})\d*(.*)$", s)
    if m:
        s = m.group(1) + m.group(2)
    dt = datetime.datetime.fromisoformat(s)
    if dt.tzinfo is None:
        return int(time.mktime(dt.timetuple()) * 1000 + dt.microsecond / 1000)
    return int(dt.timestamp() * 1000)


WRAPPED_NUM = re.compile(r"^(?:Slot|Epoch)\((\d+)\)$")
WRAPPED_ID = re.compile(r"^(?:HeaderId|ContentId)\(([0-9a-f]{64})\)$|^0x([0-9a-f]{64})$")


def parse_kv(text):
    out = {}
    for k, v in KV.findall(text):
        if v.startswith('"') and v.endswith('"'):
            try:
                v = json.loads(v)
            except Exception:
                v = v[1:-1]
        else:
            m = WRAPPED_NUM.match(v)
            if m:
                v = int(m.group(1))
            else:
                m = WRAPPED_ID.match(v)
                if m:
                    v = m.group(1) or m.group(2)
                elif re.fullmatch(r"-?\d+", v):
                    v = int(v)
        out[k] = v
    return out


def normalize(msg):
    t = msg
    for rx, rep in NORMALIZE:
        t = rx.sub(rep, t)
    return t[:300]


def rebuild_logs_if_rules_changed(db, logs_dir, prefix):
    """When the rules or the parser changed, re-read the log files still on
    disk and re-classify stored events whose file is gone (rotated away)."""
    version = rules_version(PARSER_VERSION)
    if db.meta("rules_version") == version:
        return
    on_disk = {log_file_key(p) for p in log_files_in(logs_dir, prefix)}
    log("log rules changed: re-reading %d log files" % len(on_disk))

    def w(c):
        for key in on_disk:
            for table in ("events", "log_stats", "templates"):
                c.execute("DELETE FROM %s WHERE file=?" % table, (key,))
            c.execute("DELETE FROM log_files WHERE name=?", (key,))
        rows = c.execute("SELECT rowid, ts, level, target, msg FROM events ORDER BY ts, rowid").fetchall()
        for rowid, ts, level, target, msg in rows:
            hit = classify(level, target or "", msg or "")
            if hit is None:
                c.execute("DELETE FROM events WHERE rowid=?", (rowid,))
            else:
                c.execute("UPDATE events SET category=?, kind=?, fields=? WHERE rowid=?",
                          (hit[0], hit[1], json.dumps(hit[2]), rowid))
        c.execute("DELETE FROM block_times")
        for kind, ts, fields in c.execute(
                "SELECT kind, ts, fields FROM events WHERE kind IN ('block_received','block_applied')").fetchall():
            record_block_time(c, kind, ts, fields)
        c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('in_recovery','0')")
        c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('rules_version',?)", (version,))

    db.write(w)


def log_file_key(path):
    name = os.path.basename(path)
    return name[:-3] if name.endswith(".gz") else name


def is_log_file(path, prefix):
    """`<prefix>` (simple appender), `<prefix>.<date-hour>` (rolling) or its
    `.gz`. The `.latest` symlink is skipped: it points at a real file."""
    name = os.path.basename(path)
    if os.path.islink(path) or not os.path.isfile(path):
        return False
    if not prefix:
        return True
    if name.endswith(".gz"):
        name = name[:-3]
    return name == prefix or (name.startswith(prefix + ".") and not name.endswith(".latest"))


def log_files_in(logs_dir, prefix):
    if not logs_dir or not os.path.isdir(logs_dir):
        return []
    return [p for p in glob.glob(os.path.join(logs_dir, "*")) if is_log_file(p, prefix)]


def scan_logs(db, logs_dir, prefix):
    files = log_files_in(logs_dir, prefix)
    if not files:
        return
    files.sort(key=lambda p: (os.path.getmtime(p), p))
    for p in files:
        key = log_file_key(p)
        st = db.one("SELECT offset, done FROM log_files WHERE name=?", (key,))
        offset = st["offset"] if st else 0
        if st and st["done"]:
            continue
        is_gz = p.endswith(".gz")
        if not is_gz and os.path.getsize(p) < offset:
            offset = 0  # truncated / replaced
        if not is_gz and os.path.getsize(p) == offset:
            continue
        parse_file(db, p, key, offset, is_gz)


def classify(level, target, msg):
    """(category, kind, fields) for a log message, or None if no rule matches
    and the line is not a warning/error worth keeping."""
    for rule in RULES:
        if rule.target and not target.startswith(rule.target):
            continue
        m = rule.rx.search(msg)
        if not m:
            continue
        fields = parse_kv(msg)
        for k, v in m.groupdict().items():
            if v is not None:
                fields[k] = int(v) if v.isdigit() else v
        return rule.category, rule.kind, fields
    if level in ("WARN", "ERROR"):
        return categorize_target(target), level.lower(), parse_kv(msg)
    return None


def parse_file(db, path, key, offset, is_gz):
    opener = gzip.open if is_gz else open
    events, stats, tmpl = [], {}, {}
    last_ts = [None]
    pending = [None]
    # While the node replays stored blocks at startup it logs "Received
    # proposal" for each of them; those are not arrivals.
    recovering = [db.meta("in_recovery") == "1"]

    def flush_pending():
        rec = pending[0]
        pending[0] = None
        if rec is None:
            return
        ts, level, target, msg = rec
        cat = categorize_target(target)
        minute = ts // 60000 * 60000
        sk = (minute, level, cat)
        stats[sk] = stats.get(sk, 0) + 1
        t = normalize(msg)
        tk = (t, level, target)
        e = tmpl.get(tk)
        if e is None:
            tmpl[tk] = [1, ts, ts, msg[:500]]
        else:
            e[0] += 1
            e[2] = ts
        hit = classify(level, target, msg)
        if hit is None:
            return
        category, kind, fields = hit
        if kind == "recovery_start":
            recovering[0] = True
        elif kind in ("recovery_done", "phase_enter"):
            recovering[0] = False
        elif kind == "block_received" and recovering[0]:
            category, kind = "bootstrap", "block_replayed"
        events.append((ts, level, target, category, kind, msg[:2000], json.dumps(fields), key))

    with opener(path, "rb") as f:
        if offset:
            f.seek(offset)
        pos = offset
        while True:
            raw = f.readline()
            if not raw:
                break
            if not raw.endswith(b"\n") and not is_gz:
                break  # partial line still being written
            pos += len(raw)
            line = ANSI.sub("", raw.decode("utf-8", "replace")).rstrip("\n")
            m = LINE.match(line)
            if not m:
                if pending[0] is not None and line.strip():
                    ts, level, target, msg = pending[0]
                    pending[0] = (ts, level, target, msg + "\n" + line)
                continue
            flush_pending()
            try:
                ts = parse_ts(m.group("ts"))
            except Exception:
                ts = last_ts[0] or now_ms()
            last_ts[0] = ts
            rest = SPANS.sub("", m.group("rest"), count=1)
            tm = TARGET.match(rest)
            if tm:
                target, msg = tm.group("target"), tm.group("msg")
            else:
                target, msg = "", rest
            pending[0] = (ts, m.group("level"), target, msg)
            if len(events) >= 5000:
                flush_pending()
                commit_log_batch(db, key, pos, False, events, stats, tmpl, recovering[0])
                events, stats, tmpl = [], {}, {}
        flush_pending()
    commit_log_batch(db, key, pos, is_gz, events, stats, tmpl, recovering[0])


TIME_KINDS = {"block_received": "received_ms", "block_applied": "applied_ms"}


def record_block_time(c, kind, ts, fields_json):
    col = TIME_KINDS.get(kind)
    if not col:
        return
    bid = json.loads(fields_json).get("block_id")
    if not bid:
        return
    # The first time wins: a block can be logged again (e.g. a duplicate
    # delivery that is then rejected as AlreadyApplied).
    c.execute("INSERT OR IGNORE INTO block_times(id) VALUES(?)", (bid,))
    c.execute("UPDATE block_times SET %s = coalesce(min(%s, ?), ?) WHERE id=?" % (col, col), (ts, ts, bid))


def commit_log_batch(db, key, pos, done, events, stats, tmpl, recovering=False):
    def w(c):
        c.executemany("INSERT INTO events(ts,level,target,category,kind,msg,fields,file) VALUES(?,?,?,?,?,?,?,?)", events)
        for ev in events:
            record_block_time(c, ev[4], ev[0], ev[6])
        for (minute, level, cat), n in stats.items():
            c.execute(
                "INSERT INTO log_stats(minute,level,category,file,n) VALUES(?,?,?,?,?)"
                " ON CONFLICT(minute,level,category,file) DO UPDATE SET n=n+excluded.n",
                (minute, level, cat, key, n),
            )
        for (t, level, target), (n, first, last, ex) in tmpl.items():
            c.execute(
                "INSERT INTO templates(template,file,level,target,n,first_ts,last_ts,example) VALUES(?,?,?,?,?,?,?,?)"
                " ON CONFLICT(template,file) DO UPDATE SET n=n+excluded.n, last_ts=max(last_ts, excluded.last_ts),"
                " first_ts=min(first_ts, excluded.first_ts)",
                (t, key, level, target, n, first, last, ex),
            )
        c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('in_recovery', ?)", ("1" if recovering else "0",))
        c.execute(
            "INSERT INTO log_files(name,offset,done) VALUES(?,?,?)"
            " ON CONFLICT(name) DO UPDATE SET offset=excluded.offset, done=excluded.done",
            (key, pos, 1 if done else 0),
        )

    db.write(w)


# --------------------------------------------------------------------------
# Config files
# --------------------------------------------------------------------------

SECRET_KEY = re.compile(
    r"(secret|private|priv_key|signing_key|node_key|seed|mnemonic|password|passphrase|_sk\b|^sk$)", re.I
)
CONFIG_SKIP_DIRS = {"logs"}
CONFIG_EXT = {".yaml", ".yml"}


# KMS key material is stored as `<key id>: !Zk <secret>` / `!Ed25519 <secret>`.
TAGGED_KEY = re.compile(r"^(\s*-?\s*[^:#]+:\s*!\w+)\s+\S+")


def redact_yaml(text):
    """Hide values of secret-looking keys, including multi-line list/blocks
    nested below them, and every tagged (KMS) key value."""
    out = []
    hide_indent = None
    kms_indent = None
    for line in text.splitlines():
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if stripped and not stripped.startswith("#"):
            if kms_indent is not None and indent <= kms_indent:
                kms_indent = None
            if re.match(r"^kms\s*:", stripped):
                kms_indent = indent
        tagged = TAGGED_KEY.match(line)
        if tagged and hide_indent is None:
            out.append(tagged.group(1) + " <hidden>")
            continue
        if kms_indent is not None and indent > kms_indent and re.search(r":\s*\S", stripped) \
                and re.search(r"[0-9a-fA-F]{32,}\s*$", stripped):
            out.append(re.sub(r"(:\s*)\S+\s*$", r"\1<hidden>", line))
            continue
        if hide_indent is not None:
            if stripped == "" or indent > hide_indent or (indent == hide_indent and stripped.startswith("- ")):
                if stripped:
                    out.append(" " * indent + "# <hidden>")
                continue
            hide_indent = None
        m = re.match(r"^(\s*-?\s*)([\w\"'.-]+)\s*:(.*)$", line)
        if m and SECRET_KEY.search(m.group(2).strip("\"'")):
            val = m.group(3).strip()
            if val:
                out.append("%s%s: <hidden>" % (m.group(1), m.group(2)))
            else:
                out.append(line)
                hide_indent = indent
            continue
        out.append(line)
    return "\n".join(out)


def list_config_files(data_dir, skip_dirs=()):
    """YAML files in the node folder and one level below (state/log dirs
    excluded)."""
    out = []
    skip = {os.path.realpath(d) for d in skip_dirs if d}
    for root, dirs, files in os.walk(data_dir):
        rel_root = os.path.relpath(root, data_dir)
        depth = 0 if rel_root == "." else rel_root.count(os.sep) + 1
        dirs[:] = sorted(
            d for d in dirs
            if d not in CONFIG_SKIP_DIRS and depth < 1 and os.path.realpath(os.path.join(root, d)) not in skip
        )
        for f in sorted(files):
            p = os.path.join(root, f)
            if os.path.splitext(f)[1].lower() not in CONFIG_EXT or os.path.islink(p):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_size > 2 * 1024 * 1024:
                continue
            out.append({"path": os.path.relpath(p, data_dir), "size": st.st_size,
                        "mtime_ms": int(st.st_mtime * 1000), "text": True})
    return out


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------


class App:
    def __init__(self, db, api, chain, collector, data_dir, logs_dir, state_dir, show_secrets):
        self.state_dir = state_dir
        self.db = db
        self.api = api
        self.chain = chain
        self.collector = collector
        self.data_dir = data_dir
        self.logs_dir = logs_dir
        self.show_secrets = show_secrets

    def snapshot(self, name):
        r = self.db.one("SELECT ts, json FROM snapshots WHERE name=?", (name,))
        return {"ts": r["ts"], "value": json.loads(r["json"])} if r else None

    # /api/status
    def status(self, q):
        counts = self.db.one(
            "SELECT count(*) n, sum(source='stream') live, min(slot) min_slot, max(slot) max_slot,"
            " max(height) max_height FROM blocks"
        )
        canon = self.chain.canonical()
        forks = self.db.one("SELECT count(*) n FROM blocks").__getitem__(0) - len(canon)
        reorgs = self.db.one("SELECT count(*) n, max(depth) d FROM chain_events WHERE kind='reorg'")
        return {
            "now_ms": now_ms(),
            "data_dir": self.data_dir,
            "logs_dir": self.logs_dir,
            "api": self.api.base,
            "health": self.collector.health,
            "snapshots": {n: self.snapshot(n) for n, _ in Collector.POLLS},
            "blocks": dict(counts) if counts else {},
            "canonical_known": len(canon),
            "non_canonical_known": forks,
            "reorgs": dict(reorgs) if reorgs else {},
            "log_files": [dict(r) for r in self.db.q("SELECT * FROM log_files ORDER BY name")],
            "events_total": self.db.one("SELECT count(*) FROM events")[0],
        }

    PHASE_NAMES = {
        "AwaitingGenesisTime": "Genesis wait", "InitialBlockDownload": "IBD",
        "ProlongedBootstrapPeriod": "PBP", "Following": "Following",
    }

    def phase_intervals(self):
        """[start, end, name] runs of the chain phase and of the
        Bootstrapping/Online mode, from the node's log lines (exact
        transition times), falling back to the API polls when the logs
        have none. Also the node runs (start time, height recovered from
        storage)."""
        evs = self.db.q(
            "SELECT ts, kind, fields FROM events WHERE kind IN "
            "('recovery_start','recovery_done','phase_enter','chain_online','already_online') ORDER BY ts, rowid"
        )
        now = now_ms()
        end_now = now if self.collector.health.get("api_ok") else None
        phases, modes, runs = [], [], []

        def last_log_before(ts):
            r = self.db.one("SELECT max(minute) FROM log_stats WHERE minute < ?", (ts - 60000,))
            return r[0] + 60000 if r and r[0] else ts

        def close(lst, ts):
            if lst and lst[-1][1] is None:
                lst[-1][1] = ts

        for r in evs:
            ts, kind = r["ts"], r["kind"]
            f = json.loads(r["fields"] or "{}")
            if kind == "recovery_start":
                if runs:  # the previous run ended somewhere before this restart
                    end = last_log_before(ts)
                    close(phases, end)
                    close(modes, end)
                runs.append({"start": ts, "recovered_height": None})
                close(modes, ts)
                modes.append([ts, None, "Bootstrapping"])
            elif kind == "recovery_done":
                if runs:
                    runs[-1]["recovered_height"] = f.get("tip_height")
            elif kind == "phase_enter":
                close(phases, ts)
                phases.append([ts, None, self.PHASE_NAMES.get(f.get("phase"), f.get("phase"))])
            elif kind in ("chain_online", "already_online"):
                if not modes or modes[-1][2] != "Online":
                    close(modes, ts)
                    modes.append([ts, None, "Online"])
        if not phases:
            phases = self.sample_runs("cryptarchia.phase_code",
                                      {0: "Genesis wait", 1: "IBD", 2: "PBP", 3: "Following"})
        if not modes:
            modes = self.sample_runs("cryptarchia.online", {0: "Bootstrapping", 1: "Online"})
        last_ts = self.db.one("SELECT max(ts) FROM events")[0] or now
        for lst in (phases, modes):
            if lst and lst[-1][1] is None:
                lst[-1][1] = end_now or max(last_ts, lst[-1][0])
        return {"phase": phases, "mode": modes, "runs": runs}

    def sample_runs(self, name, labels):
        out = []
        for ts, v in self.db.q("SELECT ts, value FROM samples WHERE name=? ORDER BY ts", (name,)):
            lab = labels.get(int(v))
            if lab is None:
                continue
            if out and out[-1][2] == lab and ts - out[-1][1] < 120000:
                out[-1][1] = ts
            else:
                out.append([ts, ts, lab])
        return out

    def block_phases(self, intervals):
        """{block id: (phase, mode, inferred)} for canonical blocks. Blocks the
        dashboard saw live use the phase at that moment. Older ones take the
        phase of the next live-seen block above them when they were processed
        in the same node run (above the height that run recovered from
        storage); they are flagged as inferred."""
        import bisect

        def lookup(lst, ts):
            if ts is None or not lst:
                return None
            i = bisect.bisect_right([x[0] for x in lst], ts) - 1
            return lst[i][2] if i >= 0 and ts <= lst[i][1] + 10000 else None

        def run_of(ts):
            run = None
            for r in intervals["runs"]:
                if r["start"] <= ts:
                    run = r
            return run

        canon = self.chain.canonical()
        rows = self.db.q("SELECT b.id, b.height, %s FROM %s WHERE b.height IS NOT NULL ORDER BY b.height DESC"
                         % (T_MS, JOIN_T))
        out, carry = {}, None
        for bid, height, seen in rows:
            if bid not in canon:
                if seen is not None:
                    out[bid] = (lookup(intervals["phase"], seen), lookup(intervals["mode"], seen), 0)
                continue
            if seen is not None:
                ph, md = lookup(intervals["phase"], seen), lookup(intervals["mode"], seen)
                out[bid] = (ph, md, 0)
                run = run_of(seen)
                carry = (ph, md, (run or {}).get("recovered_height")) if ph else None
            elif carry and (carry[2] is None or height > carry[2]):
                out[bid] = (carry[0], carry[1], 1)
        return out

    # /api/phases
    def phases(self, q):
        return self.phase_intervals()

    # /api/tree
    def tree(self, q):
        """Blocks in a height window, plus everything needed to draw them."""
        tip = self.chain.tip
        top = self.db.one("SELECT max(height) FROM blocks")[0]
        if "to_height" in q:
            top = int(q["to_height"])
        window = min(int(q.get("window", 300)), 20000)
        if top is None:
            rows = self.db.q(
                "SELECT b.id,b.parent,b.slot,b.height,%s AS t_ms,%s AS t_src,b.tx_count,b.uncle_count,b.source"
                " FROM %s ORDER BY b.slot DESC LIMIT ?" % (T_MS, T_SRC, JOIN_T),
                (window,),
            )
        else:
            rows = self.db.q(
                "SELECT b.id,b.parent,b.slot,b.height,%s AS t_ms,%s AS t_src,b.tx_count,b.uncle_count,b.source"
                " FROM %s WHERE (b.height BETWEEN ? AND ?) OR (b.height IS NULL AND b.slot >= (SELECT coalesce(min(slot),0)"
                " FROM blocks WHERE height >= ?))" % (T_MS, T_SRC, JOIN_T),
                (top - window, top, top - window),
            )
        canon = self.chain.canonical()
        lib = self.chain.lib
        lib_row = self.db.one("SELECT height, slot FROM blocks WHERE id=?", (lib,)) if lib else None
        intervals = self.phase_intervals()
        bp = self.block_phases(intervals)
        nodes = []
        for r in rows:
            ph = bp.get(r["id"], (None, None, 0))
            nodes.append([r["id"], r["parent"], r["slot"], r["height"], 1 if r["id"] in canon else 0, r["t_ms"],
                          r["tx_count"], r["uncle_count"], r["source"], ph[0], ph[1], ph[2], r["t_src"]])
        bounds = self.db.one("SELECT min(height), max(height) FROM blocks")
        return {
            "tip": tip,
            "lib": lib,
            "lib_height": lib_row["height"] if lib_row else None,
            "lib_slot": lib_row["slot"] if lib_row else None,
            "min_height": bounds[0],
            "max_height": bounds[1],
            "fields": ["id", "parent", "slot", "height", "canonical", "t_ms", "txs", "uncles", "source",
                       "phase", "mode", "inferred", "time_src"],
            "intervals": intervals,
            "nodes": nodes,
            "reorgs": [dict(r) for r in self.db.q(
                "SELECT ts, old, new, slot, depth FROM chain_events WHERE kind='reorg' ORDER BY ts DESC LIMIT 200")],
        }

    # /api/block/<id>
    def block(self, bid, q):
        if not HEX64.fullmatch(bid):
            raise ValueError("bad block id")
        r = self.db.one("SELECT * FROM blocks WHERE id=?", (bid,))
        block = unpack_block(r["json"]) if r else None
        node_events = None
        if block is None:
            # Unknown, or an old canonical block whose JSON was dropped to save
            # space: the node still has it.
            try:
                block = self.api.get("/cryptarchia/blocks/" + bid)
                if block and r is None:
                    self.db.write(lambda c: self.chain.store_block(c, block, "api"))
                    r = self.db.one("SELECT * FROM blocks WHERE id=?", (bid,))
            except Exception as e:
                if r is None:
                    return {"error": "unknown block (%s)" % e}
        try:
            node_events = self.api.get("/cryptarchia/blocks/%s/events" % bid)
        except Exception as e:
            node_events = {"_error": str(e)}
        children = [dict(x) for x in self.db.q("SELECT id, slot, height FROM blocks WHERE parent=?", (bid,))]
        log_mentions = [dict(x) for x in self.db.q(
            "SELECT ts, level, target, kind, msg FROM events WHERE msg LIKE ? ORDER BY ts LIMIT 100", ("%" + bid + "%",))]
        meta = {k: r[k] for k in r.keys() if k not in ("json", "ops")} if r else {}
        meta["ops"] = json.loads(r["ops"]) if r and r["ops"] else op_counts(block or {})
        bt = self.db.one("SELECT received_ms, applied_ms FROM block_times WHERE id=?", (bid,))
        meta["received_ms"] = bt["received_ms"] if bt else None
        meta["applied_ms"] = bt["applied_ms"] if bt else None
        meta["canonical"] = bid in self.chain.canonical()
        meta["is_tip"] = bid == self.chain.tip
        meta["is_lib"] = bid == self.chain.lib
        return {"meta": meta, "block": block, "children": children, "node_events": node_events,
                "log_mentions": log_mentions}

    # /api/blocks — per-block rows for plots
    def blocks(self, q):
        since = int(q.get("since_slot", 0))
        rows = self.db.q(
            "SELECT b.id, b.slot, b.height, %s AS t_ms, b.tx_count, b.uncle_count, b.source, b.ops, b.size, %s AS t_src,"
            " bt.received_ms, bt.applied_ms FROM %s WHERE b.slot >= ? ORDER BY b.slot" % (T_MS, T_SRC, JOIN_T),
            (since,),
        )
        canon = self.chain.canonical()
        bp = self.block_phases(self.phase_intervals())
        return {
            "fields": ["slot", "height", "t_ms", "txs", "uncles", "canonical", "live", "id", "ops", "size", "phase",
                       "time_src", "received_ms", "applied_ms"],
            "rows": [[r["slot"], r["height"], r["t_ms"], r["tx_count"], r["uncle_count"],
                      1 if r["id"] in canon else 0, 1 if r["source"] == "stream" else 0, r["id"],
                      json.loads(r["ops"]) if r["ops"] else None, r["size"],
                      bp.get(r["id"], (None,))[0], r["t_src"], r["received_ms"], r["applied_ms"]] for r in rows],
        }

    # /api/chain_events?since=ms
    def chain_events(self, q):
        rows = self.db.q(
            "SELECT ts, kind, old, new, slot, depth FROM chain_events WHERE ts >= ? ORDER BY ts",
            (int(q.get("since", 0)),),
        )
        return [dict(r) for r in rows]

    # /api/series?names=a,b&since=ms
    def series(self, q):
        since = int(q.get("since", 0))
        names = [n for n in q.get("names", "").split(",") if n]
        out = {}
        for n in names:
            rows = self.db.q("SELECT ts, value FROM samples WHERE name=? AND ts>=? ORDER BY ts", (n, since))
            out[n] = downsample([[r[0], r[1]] for r in rows], 2000)
        return out

    def series_names(self, q):
        return [r[0] for r in self.db.q("SELECT DISTINCT name FROM samples ORDER BY name")]

    # /api/events?kinds=a,b&category=&level=&since=&limit=
    def events(self, q):
        where, args = ["ts >= ?"], [int(q.get("since", 0))]
        if q.get("kinds"):
            ks = q["kinds"].split(",")
            where.append("kind IN (%s)" % ",".join("?" * len(ks)))
            args += ks
        if q.get("category"):
            where.append("category = ?")
            args.append(q["category"])
        if q.get("level"):
            ls = q["level"].split(",")
            where.append("level IN (%s)" % ",".join("?" * len(ls)))
            args += ls
        if q.get("grep"):
            where.append("msg LIKE ?")
            args.append("%" + q["grep"] + "%")
        limit = min(int(q.get("limit", 5000)), 50000)
        order = "ASC" if q.get("order") == "asc" else "DESC"
        rows = self.db.q(
            "SELECT ts, level, target, category, kind, msg, fields FROM events WHERE %s ORDER BY ts %s LIMIT ?"
            % (" AND ".join(where), order),
            args + [limit],
        )
        return [
            {"ts": r[0], "level": r[1], "target": r[2], "category": r[3], "kind": r[4], "msg": r[5],
             "fields": json.loads(r[6]) if r[6] else {}}
            for r in rows
        ]

    # /api/logsummary
    def log_summary(self, q):
        since = int(q.get("since", 0))
        stats = self.db.q(
            "SELECT minute, level, category, sum(n) FROM log_stats WHERE minute >= ?"
            " GROUP BY minute, level, category ORDER BY minute", (since,)
        )
        kinds = self.db.q(
            "SELECT category, kind, count(*) n, min(ts) first, max(ts) last FROM events WHERE ts >= ?"
            " GROUP BY category, kind ORDER BY category, n DESC",
            (since,),
        )
        templates = self.db.q(
            "SELECT template, level, target, sum(n) AS n, min(first_ts) AS first_ts, max(last_ts) AS last_ts,"
            " max(example) AS example FROM templates GROUP BY template ORDER BY n DESC LIMIT 400"
        )
        return {
            "stats": [list(r) for r in stats],
            "kinds": [dict(r) for r in kinds],
            "templates": [dict(r) for r in templates],
        }

    # /api/config
    def config(self, q):
        files = list_config_files(self.data_dir, [self.logs_dir, self.state_dir])
        path = q.get("file")
        content = None
        if path:
            # Only files from the listing can be read.
            if path not in {f["path"] for f in files}:
                raise ValueError("not a listed config file")
            full = os.path.join(self.data_dir, path)
            with open(full, "rb") as f:
                text = f.read(2 * 1024 * 1024).decode("utf-8", "replace")
            redacted = not self.show_secrets
            if redacted:
                text = redact_yaml(text)
            content = {"path": path, "text": text, "redacted": redacted}
        return {"data_dir": self.data_dir, "files": files, "content": content}

    # /api/logtail?n=&grep=
    def log_tail(self, q):
        n = min(int(q.get("n", 300)), 5000)
        grep = q.get("grep", "")
        latest = sorted(
            (p for p in log_files_in(self.logs_dir, self.collector.log_prefix) if not p.endswith(".gz")),
            key=os.path.getmtime,
        )
        if not latest:
            return {"file": None, "lines": []}
        path = latest[-1]
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 4 * 1024 * 1024))
            lines = f.read().decode("utf-8", "replace").splitlines()
        lines = [ANSI.sub("", l) for l in lines]
        if grep:
            lines = [l for l in lines if grep.lower() in l.lower()]
        return {"file": os.path.basename(path), "lines": lines[-n:]}


def downsample(points, maxn):
    if len(points) <= maxn:
        return points
    step = len(points) / maxn
    return [points[int(i * step)] for i in range(maxn)] + [points[-1]]


def make_handler(app):
    routes = {
        "/api/status": app.status,
        "/api/tree": app.tree,
        "/api/blocks": app.blocks,
        "/api/chain_events": app.chain_events,
        "/api/phases": app.phases,
        "/api/series": app.series,
        "/api/series_names": app.series_names,
        "/api/events": app.events,
        "/api/logsummary": app.log_summary,
        "/api/config": app.config,
        "/api/logtail": app.log_tail,
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = {k: v[-1] for k, v in urllib.parse.parse_qs(u.query).items()}
            try:
                if u.path in routes:
                    return self.json(routes[u.path](q))
                if u.path.startswith("/api/block/"):
                    return self.json(app.block(u.path[len("/api/block/"):], q))
                if u.path == "/api/backfill":
                    threading.Thread(target=app.collector.backfill_once, daemon=True).start()
                    return self.json({"started": True})
                return self.static(u.path)
            except ValueError as e:  # bad input from the client
                self.json({"error": str(e)}, 400)
            except Exception as e:
                traceback.print_exc()
                self.json({"error": str(e)}, 500)

        def json(self, obj, code=200):
            self.send(code, json.dumps(obj).encode(), "application/json")

        def static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip("/")))
            if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
                return self.send(404, b"not found", "text/plain")
            with open(full, "rb") as f:
                body = f.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self.send(200, body, ctype)

    return Handler


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def running_node():
    """(config dir, working dir) of a `logos-blockchain-node <config>` process,
    if one runs directly (outside logosctl)."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        parts = cmd.split()
        if not parts or not os.path.basename(parts[0]).startswith("logos-blockchain-node"):
            continue
        cfg = next((a for a in parts[1:] if a.endswith((".yaml", ".yml"))), "user_config.yaml")
        cwd = None
        if os.path.isdir("/proc/%s" % pid):
            try:
                cwd = os.readlink("/proc/%s/cwd" % pid)
            except OSError:
                pass
        else:
            try:
                lo = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=5).stdout
                cwd = next((l[1:] for l in lo.splitlines() if l.startswith("n")), None)
            except Exception:
                pass
        if cwd:
            path = os.path.join(cwd, cfg)
            if os.path.isfile(path):
                return os.path.dirname(os.path.abspath(path)), cwd
    return None


def default_data_dir():
    node = running_node()
    if node:
        return node[0]
    # Same choice as 3_run_blockchain.sh: the first instance dir alphabetically.
    cands = sorted(glob.glob(os.path.expanduser("~/.logosctl/data/blockchain_module/*/user_config.yaml")))
    return os.path.dirname(cands[0]) if cands else None


def yaml_path_value(text, path):
    """Scalar at a nested key path in simple block YAML (no flow style)."""
    stack = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith(("#", "- ")):
            continue
        indent = len(line) - len(line.lstrip(" "))
        m = re.match(r"^\s*([\w.-]+):\s*(.*)$", line)
        if not m:
            continue
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, m.group(1)))
        if [k for _, k in stack] == path:
            v = m.group(2).strip()
            return v.strip("'\"") if v and not v.startswith("!") else None
    return None


def node_paths(data_dir, cwd=None):
    """Log dir, log prefix and state dir as the node resolves them. Relative
    paths are relative to the node's working dir: the running node's if known,
    else assumed to be the config's dir."""
    try:
        with open(os.path.join(data_dir, "user_config.yaml")) as f:
            text = f.read()
    except OSError:
        text = ""

    base = cwd or data_dir

    def resolve(p):
        return os.path.normpath(os.path.join(base, os.path.expanduser(p))) if p else None

    return {
        "logs_dir": resolve(yaml_path_value(text, ["tracing", "logger", "file", "directory"])),
        "log_prefix": yaml_path_value(text, ["tracing", "logger", "file", "prefix"]),
        "state_dir": resolve(yaml_path_value(text, ["state", "base_folder"])),
    }


def api_from_config(data_dir):
    p = os.path.join(data_dir or "", "user_config.yaml")
    try:
        with open(p) as f:
            text = f.read()
    except OSError:
        return None
    m = re.search(r"^\s*listen_address:\s*['\"]?([\d.]+|\[[^\]]+\]):(\d+)", text, re.M)
    if not m:
        return None
    host = m.group(1)
    if host in ("0.0.0.0", "[::]"):
        host = "127.0.0.1"
    return "http://%s:%s" % (host, m.group(2))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", help="dir holding user_config.yaml (default: a running logos-blockchain-node's, "
                    "else ~/.logosctl/data/blockchain_module/<first>)")
    ap.add_argument("--logs-dir", help="log dir (default: tracing.logger.file.directory in user_config.yaml)")
    ap.add_argument("--log-prefix", help="log file name prefix (default: tracing.logger.file.prefix; '' = all files)")
    ap.add_argument("--api", help="node HTTP API base URL (default: from user_config.yaml, else http://127.0.0.1:8080)")
    ap.add_argument("--host", default="0.0.0.0", help="dashboard listen host (default 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8090, help="dashboard listen port (default 8090)")
    ap.add_argument("--db", help="SQLite file (default: ~/.logos-dashboard/<instance>.db)")
    ap.add_argument("--poll", type=float, default=5, help="API poll interval in seconds")
    ap.add_argument("--keep-block-json", type=int, default=2000, metavar="N",
                    help="keep full JSON of canonical blocks only for the newest N heights; older ones are "
                    "fetched from the node on click (fork blocks are always kept; 0 = keep everything)")
    ap.add_argument("--show-secrets", action="store_true", help="serve config files without hiding secret keys")
    ap.add_argument(
        "--metrics-cmd",
        help="shell command printing the node's OpenMetrics text (default: "
        "'logosctl call blockchain_module get_open_metrics' when logosctl is on PATH; '' disables)",
    )
    args = ap.parse_args()
    if args.metrics_cmd is None:
        lc = shutil.which("logosctl") or (
            os.path.expanduser("~/.local/bin/logosctl") if os.path.exists(os.path.expanduser("~/.local/bin/logosctl")) else None
        )
        args.metrics_cmd = "%s call blockchain_module get_open_metrics" % lc if lc else ""

    data_dir = args.data_dir or default_data_dir()
    if not data_dir or not os.path.isdir(data_dir):
        sys.exit("node data dir not found; pass --data-dir")
    data_dir = os.path.abspath(os.path.expanduser(data_dir))
    node = running_node()
    node_cwd = node[1] if node and os.path.samefile(node[0], data_dir) else None
    if node_cwd and os.path.realpath(node_cwd) != os.path.realpath(data_dir):
        log("node runs in", node_cwd, "- resolving relative config paths from there")
    node_cfg = node_paths(data_dir, node_cwd)
    logs_dir = os.path.abspath(os.path.expanduser(args.logs_dir or node_cfg["logs_dir"] or os.path.join(data_dir, "logs")))
    log_prefix = args.log_prefix if args.log_prefix is not None else (node_cfg["log_prefix"] or "logos-blockchain.log")
    api_base = args.api or api_from_config(data_dir) or "http://127.0.0.1:8080"
    db_path = args.db or os.path.expanduser("~/.logos-dashboard/%s.db" % os.path.basename(data_dir))
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    log("data dir :", data_dir)
    log("logs dir :", logs_dir, "(files %s*)" % log_prefix)
    log("node api :", api_base)
    log("database :", db_path)

    db = DB(db_path)
    api = Api(api_base)
    chain = Chain(db)
    # Resume tip/LIB from the last chain event so reorg detection continues.
    last = db.one("SELECT new FROM chain_events WHERE kind IN ('tip','reorg') ORDER BY ts DESC LIMIT 1")
    if last:
        chain.tip = last[0]
    last = db.one("SELECT new FROM chain_events WHERE kind='lib' ORDER BY ts DESC LIMIT 1")
    if last:
        chain.lib = last[0]

    collector = Collector(db, api, chain, logs_dir, log_prefix, args.poll, args.metrics_cmd, args.keep_block_json)
    collector.start()

    app = App(db, api, chain, collector, data_dir, logs_dir, node_cfg["state_dir"], args.show_secrets)
    srv = Server((args.host, args.port), make_handler(app))
    log("dashboard on http://%s:%d" % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
