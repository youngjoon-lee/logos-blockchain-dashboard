"""Write synthetic node logs (tracing default format with ANSI) and config files.

Usage: python3 dev/gen_logs.py <out-dir> <mock-api-port>
The keys in the generated user_config.yaml are fake (they exist to test that
the dashboard hides secret-looking values).
"""
import datetime, gzip, hashlib, os, random, sys, time

root = sys.argv[1]
port = sys.argv[2]
logs = os.path.join(root, "logs")
os.makedirs(logs, exist_ok=True)
random.seed(2)

open(os.path.join(root, "user_config.yaml"), "w").write(f"""network:
  backend:
    swarm:
      host: 0.0.0.0
      port: 3000
      node_key: 9f2c0d0b1a7e5f3c2d4b6a8e0f1c3d5b7a9e1f3c5d7b9a1e3f5c7d9b1a3e5f7c
    initial_peers:
      - /ip4/65.109.51.37/udp/3000/quic-v1/p2p/12D3KooWFrouXfmrR4nsLMtE7wu15DoMJ6VtoUtHinREZCvbWHar
blend:
  non_ephemeral_signing_key_id: abc
  secret_key:
    - 12
    - 34
cryptarchia:
  funding_pk: 00aa
api:
  backend:
    listen_address: 127.0.0.1:{port}
    cors_origins: []
tracing:
  logger:
    file:
      directory: {logs}
  level: INFO
""")
open(os.path.join(root, "deployment.yaml"), "w").write("chain_id: devnet\nslot_duration: 1s\n")
os.makedirs(os.path.join(root, "db"), exist_ok=True)
open(os.path.join(root, "db", "000001.sst"), "wb").write(b"\0" * 1000)

LV = {"INFO": "\x1b[32m INFO\x1b[0m", "WARN": "\x1b[33m WARN\x1b[0m", "ERROR": "\x1b[31mERROR\x1b[0m", "DEBUG": "\x1b[34mDEBUG\x1b[0m"}


def line(ts, level, target, msg, **fields):
    t = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    f = "".join(f" \x1b[3m{k}\x1b[0m\x1b[2m=\x1b[0m{v}" for k, v in fields.items())
    return f"\x1b[2m{t}\x1b[0m {LV[level]} \x1b[2m{target}\x1b[0m\x1b[2m:\x1b[0m {msg}{f}\n"


def hx(*a):
    return hashlib.sha256(repr(a).encode()).hexdigest()


now = time.time()
start = now - 5.5 * 3600
L = []
t = start
L.append(line(t, "INFO", "logos_blockchain::chain::service", "Service 'Cryptarchia' is ready."))
L.append(line(t + 1, "INFO", "logos_blockchain::chain::service", "recovering Cryptarchia", tip=f"HeaderId({hx(1)})", lib=f"HeaderId({hx(2)})", lib_height=100, genesis=f"HeaderId({'0'*64})"))
L.append(line(t + 2, "INFO", "logos_blockchain::chain::service", "found 37 stored blocks to replay during chain recovery"))
L.append(line(t + 5, "INFO", "logos_blockchain::chain::service", "37 blocks replayed. Chain recovery finished", tip_height=137, lib_height=100))
L.append(line(t + 6, "INFO", "logos_blockchain::chain::service", "entering InitialBlockDownload { ibd_skipped: false } phase"))
L.append(line(t + 7, "INFO", "logos_blockchain::chain::network::bootstrap::ibd", "Starting Initial Block Download with 4 peers"))
L.append(line(t + 30, "WARN", "logos_blockchain::chain::network::bootstrap::ibd", "failed to fetch tip from PeerId(\"12D3KooWFrou\"): timeout"))
L.append(line(t + 600, "INFO", "logos_blockchain::chain::network::bootstrap::ibd", "IBD complete: all configured peer tips are present in the local tree"))
L.append(line(t + 601, "INFO", "logos_blockchain::chain::service", "IBD completed: finishing InitialBlockDownload { ibd_skipped: false } phase"))
L.append(line(t + 602, "INFO", "logos_blockchain::chain::service", "entering ProlongedBootstrapPeriod phase"))
L.append(line(t + 3000, "INFO", "logos_blockchain::chain::service", "Prolonged Bootstrap Period completed: switching chain to online"))
L.append(line(t + 3000, "INFO", "logos_blockchain::chain::service", "chain switched to online"))
L.append(line(t + 3001, "INFO", "logos_blockchain::chain::service", "entering Following phase"))
L.append(line(t + 3002, "INFO", "logos_blockchain::pow", "PoW mining started"))
L.append(line(t + 3003, "INFO", "logos_blockchain::blend::service", "Blend mode changed", diagnostic='"blend_reachability"', event='"blend_mode_changed"', previous_mode='"Broadcast"', new_mode='"Core"'))
L.append(line(t + 3004, "INFO", "logos_blockchain::blend::service", "current membership is ready", members=11))
claimable = 0
while t < now:
    t += random.expovariate(1 / 20)
    r = random.random()
    if r < 0.05:
        claimable += 1
        L.append(line(t, "INFO", "logos_blockchain::pow", f"Mined a winning ticket 💲; total claimable tickets {claimable}"))
    elif r < 0.06 and claimable:
        L.append(line(t, "INFO", "logos_blockchain::pow", f"Claimed {claimable} PoW reward(s); 0 still ready"))
        claimable = 0
    elif r < 0.09:
        L.append(line(t, "INFO", "logos_blockchain::chain::leader", f"proposed block HeaderId({hx('p', t)}) with {random.randint(0,3)} transactions (0 removed)"))
    elif r < 0.12:
        live = random.randint(2, 5)
        L.append(line(t, "WARN", "logos_blockchain::blend::network::core::core::behaviour", f"Holding fewer connections than the protocol asks for: {live} live of 6 wanted, 1 of 3 opened by this node."))
    elif r < 0.13:
        L.append(line(t, "INFO", "logos_blockchain::blend::network::core::core::behaviour", "Back to the connections the protocol asks for after 3 round(s): 6 live, 3 opened by this node."))
    elif r < 0.16:
        L.append(line(t, "ERROR", "logos_blockchain::chain::service", f"Failed to process block: ParentMissing {{ parent: HeaderId({hx('x', t)}), info: CryptarchiaInfo {{ lib: HeaderId({hx(2)}), lib_slot: Slot(5), tip: HeaderId({hx(3)}), slot: Slot(9), height: 4, state: Online }} }}"))
    elif r < 0.17:
        L.append(line(t, "ERROR", "logos_blockchain::chain::service", f"Failed to process block: AlreadyApplied(HeaderId({hx('y', t)}))"))
    elif r < 0.19:
        L.append(line(t, "INFO", "logos_blockchain::chain::network", "tip poll: enqueued peer tip for catch-up", tip=f"HeaderId({hx('t', t)})", height=500, local_height=497))
    elif r < 0.21:
        L.append(line(t, "WARN", "logos_blockchain::blend::service", "The Blend network did not deliver 2 locally-originated payload(s) within the delivery deadline; broadcasting them directly."))
    elif r < 0.22:
        L.append(line(t, "INFO", "logos_blockchain::ledger::cryptarchia", "epoch transition", old_epoch="Epoch(3)", new_epoch="Epoch(4)", old_total_stake=1000, new_total_stake=1000 + int(t) % 97, slot="Slot(2000)"))
    elif r < 0.25:
        L.append(line(t, "WARN", "logos_blockchain::blend::backend::libp2p", f"Dialing error for peer: PeerId(\"12D3KooW{random.randint(0,9)}\") on connection: ConnectionId(4). Error: Transport"))
    elif r < 0.27:
        L.append(line(t, "INFO", "logos_blockchain::sdp", "Submitted SDP activity transaction", event='"sdp_activity_tx_submitted"', proof_epoch=3, chain_epoch=4, chain_slot=2001))
    else:
        L.append(line(t, "INFO", "logos_blockchain::blend::service::edge::backend::libp2p", "Message sent successfully to peer PeerId(\"12D3KooWx\") on connection ConnectionId(7)."))
# multi-line debug message
L.append(line(now - 10, "WARN", "logos_blockchain::chain::service::sync::block-provider", "Providing blocks:\n            target_block=HeaderId(aa),\n            known_blocks=[]"))

# split hourly into files
by_hour = {}
for l in L:
    ts = l[4:30]
    hour = ts[:13].replace("T", "-")
    by_hour.setdefault(hour, []).append(l)
hours = sorted(by_hour)
for i, h in enumerate(hours):
    name = os.path.join(logs, f"logos-blockchain.log.{h}")
    data = "".join(by_hour[h]).encode()
    if i < len(hours) - 3:
        with gzip.open(name + ".gz", "wb") as f:
            f.write(data)
    else:
        open(name, "wb").write(data)
latest = os.path.join(logs, "logos-blockchain.log.latest")
if os.path.lexists(latest):
    os.remove(latest)
os.symlink(f"logos-blockchain.log.{hours[-1]}", latest)
print(len(L), "lines in", len(hours), "files")
