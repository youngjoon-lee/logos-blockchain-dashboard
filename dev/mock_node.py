"""Mock logos node HTTP API for testing the dashboard.

Usage: python3 dev/mock_node.py [port]   (default 18080)
Serves the endpoints the dashboard uses, with a pre-built chain that has short
forks, and keeps producing a block every 2 s, sometimes with a 2-block reorg.
"""
import hashlib, http.server, json, random, socketserver, sys, threading, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
SLOT_MS = 1000
GENESIS = int(time.time() * 1000) - 2000 * SLOT_MS
random.seed(1)

blocks = {}       # id -> block json
order = []        # all ids in creation order
children = {}
lock = threading.Lock()
subs = []


def hid(*parts):
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()


def mk(parent, slot, tag=""):
    bid = hid(parent, slot, tag)
    b = {"header": {"id": bid, "parent_block": parent, "slot": slot, "body_root": hid("body", bid),
                    "proof_of_leadership": {"proof": "ab" * 32, "entropy_contribution": "cd" * 16}},
         "uncle_headers": [], "transactions": [{"mantle_tx": {"ops": []}, "hash": hid("tx", bid, i)} for i in range(random.randint(0, 4))]}
    blocks[bid] = b
    order.append(bid)
    children.setdefault(parent, []).append(bid)
    return bid


GEN = "0" * 64
height = {GEN: 0}
tip = mk(GEN, 0, "g")
height[tip] = 1
lib = tip
slot = 0
while slot < 1800:
    slot += random.randint(1, 30)
    nb = mk(tip, slot)
    height[nb] = height[tip] + 1
    if random.random() < 0.08:  # short fork
        f = mk(tip, slot + 1, "fork")
        height[f] = height[tip] + 1
        if random.random() < 0.5:
            f2 = mk(f, slot + 5, "fork2")
            height[f2] = height[f] + 1
    tip = nb


def canonical_chain(t):
    out = []
    while t in blocks:
        out.append(t)
        t = blocks[t]["header"]["parent_block"]
    return out


def update_lib():
    global lib
    ch = canonical_chain(tip)
    lib = ch[min(20, len(ch) - 1)]


update_lib()


def event(bid):
    return {"block": blocks[bid], "tip": tip, "tip_slot": blocks[tip]["header"]["slot"], "lib": lib,
            "lib_slot": blocks[lib]["header"]["slot"]}


def producer():
    global tip, slot
    while True:
        time.sleep(2)
        with lock:
            now_slot = (int(time.time() * 1000) - GENESIS) // SLOT_MS
            new = []
            r = random.random()
            if r < 0.15:
                # reorg: build a 2-block branch from tip's grandparent
                gp = blocks[blocks[tip]["header"]["parent_block"]]["header"]["parent_block"]
                a = mk(gp, now_slot - 1, "re")
                height[a] = height[gp] + 1
                b = mk(a, now_slot, "re2")
                height[b] = height[a] + 1
                c = mk(b, now_slot, "re3")
                height[c] = height[b] + 1
                new = [a, b, c]
                tip = c
            else:
                nb = mk(tip, now_slot)
                height[nb] = height[tip] + 1
                new = [nb]
                tip = nb
                if r > 0.9:
                    f = mk(blocks[nb]["header"]["parent_block"], now_slot, "f")
                    height[f] = height[nb]
                    new.append(f)
            update_lib()
            evs = [event(b) for b in new]
        for q in list(subs):
            for e in evs:
                q.append(e)


threading.Thread(target=producer, daemon=True).start()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def j(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def ndjson_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def chunk(self, obj):
        data = (json.dumps(obj) + "\n").encode()
        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        self.wfile.flush()

    def do_GET(self):
        p = self.path.split("?")[0]
        qs = dict(x.split("=", 1) for x in self.path.split("?", 1)[1].split("&")) if "?" in self.path else {}
        now_slot = (int(time.time() * 1000) - GENESIS) // SLOT_MS
        if p == "/cryptarchia/info":
            with lock:
                return self.j({"cryptarchia_info": {"lib": lib, "lib_slot": blocks[lib]["header"]["slot"], "tip": tip,
                               "slot": blocks[tip]["header"]["slot"], "height": height[tip], "state": "Online"},
                               "phase": "Following"})
        if p == "/time/info":
            return self.j({"slot_duration_ms": SLOT_MS, "genesis_time_unix_ms": GENESIS, "current_slot": now_slot,
                           "current_epoch": now_slot // 500, "slots_per_epoch": 500})
        if p == "/network/info":
            n = random.randint(4, 9)
            return self.j({"listen_addresses": ["/ip4/0.0.0.0/udp/3000/quic-v1"], "peer_id": "12D3KooWMock",
                           "connected_peers": ["p%d" % i for i in range(n)], "n_peers": n, "n_connections": n + 1,
                           "n_pending_connections": random.randint(0, 2), "external_addresses": []})
        if p == "/blend/info":
            return self.j({"mode": "Core", "members": random.randint(10, 12), "session": now_slot // 500})
        if p == "/pow/status":
            return self.j({"mining": True, "auto_claim": {"enabled": True, "claimable": random.randint(0, 5)}})
        if p == "/version":
            return self.j("0.3.2-mock")
        if p == "/mempool/view":
            return self.j([1, 2, 3][: random.randint(0, 3)])
        if p == "/cryptarchia/events/blocks/stream":
            q = []
            subs.append(q)
            self.ndjson_start()
            try:
                with lock:
                    self.chunk(event(tip))
                while True:
                    while q:
                        self.chunk(q.pop(0))
                    time.sleep(0.2)
            except Exception:
                subs.remove(q)
            return
        if p == "/cryptarchia/blocks_range":
            limit = int(qs.get("blocks_limit", 100))
            slot_to = int(qs.get("slot_to", 10 ** 12))
            with lock:
                ch = [b for b in canonical_chain(tip) if blocks[b]["header"]["slot"] <= slot_to][:limit]
                evs = [event(b) for b in ch]
            self.ndjson_start()
            for e in evs:
                self.chunk(e)
            self.wfile.write(b"0\r\n\r\n")
            return
        if p.startswith("/cryptarchia/blocks/"):
            parts = p.split("/")
            bid = parts[3]
            if bid not in blocks:
                return self.j({"error": "not found"}, 404)
            if len(parts) > 4 and parts[4] == "events":
                return self.j({"events": [{"type": "Transfer", "amount": 5}]})
            return self.j(blocks[bid])
        self.j({"error": "nope"}, 404)


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


print("mock node on", PORT, "blocks", len(blocks), flush=True)
S(("127.0.0.1", PORT), H).serve_forever()
