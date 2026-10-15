# Logos blockchain dashboard

A web dashboard for a [logos-blockchain](https://github.com/logos-blockchain/logos-blockchain) node, either started by `logosctl` or run directly as `logos-blockchain-node`. It runs next to the node (e.g. on a Raspberry Pi), collects everything it can from the node's HTTP API, log files and config into a local SQLite database, and serves it as a web page.

It is a single Python 3 script with no dependencies: no pip, no build step, no CDN.

- **Block tree**: every block the node processed, forks included, with the canonical chain, LIB, the immutable range, reorgs, and blocks proposed by this node. Bands show the chain phase (Genesis wait, IBD, PBP, Following), Bootstrapping/Online mode and epoch for each block. Click a block for its header, transactions and ops, ledger events, exact receive/apply times and log lines.
- **Chain & sync**: tip/LIB/wall-clock slots, phase timeline, IBD and startup recovery, blocks applied per minute, arrival delay, processing time, reorgs, rejected blocks by reason, chain sync and orphan handling.
- **Activity**: ops by type over the whole canonical history, block production rate, block sizes, transactions per block.
- **Blend, Leader & PoW, Network**: blend mode/connections/failures, own proposals, leader wins, PoW tickets and claims, peers, plus every numeric field the API returns.
- **Logs**: line counts by level and subsystem, matched events, most frequent messages, search, live tail.
- **Config**: the YAML files in the node folder, with secret keys hidden.

All times are shown in the viewer's local timezone.

## Run

```bash
git clone https://github.com/youngjoon-lee/logos-blockchain-dashboard
cd logos-blockchain-dashboard
python3 dashboard.py                    # http://<host>:8090
python3 dashboard.py --host 127.0.0.1   # local only
```

Requires Python 3.9 or newer. The dashboard only reads from the node; it never changes its state.

It finds the node on its own:

- **Node folder** (the one with `user_config.yaml`): a running `logos-blockchain-node` process (its config argument and working dir). If none is running, the first `~/.logosctl/data/blockchain_module/*/` (the `logosctl` setup).
- **Node API**: `api.backend.listen_address` from `user_config.yaml` (normally `127.0.0.1:8080`).
- **Logs**: `tracing.logger.file.directory` and `prefix` from `user_config.yaml`. Only the node's own log files are parsed, even when they share a folder with other files. Relative paths are resolved from the running node's working dir.
- **Database**: `~/.logos-dashboard/<node folder name>.db`.

The dashboard's own working dir does not matter. Pass `--data-dir` when the node is not running at the moment you start the dashboard, or when more than one node runs. Detection happens once at startup. `python3 dashboard.py --help` lists all options:

| Option | Default | |
|---|---|---|
| `--data-dir` | auto | folder with the node's `user_config.yaml` |
| `--logs-dir`, `--log-prefix` | from `user_config.yaml` | where the node writes logs (`--log-prefix ''` reads every file) |
| `--api` | from `user_config.yaml` | node HTTP API base URL |
| `--host`, `--port` | `0.0.0.0`, `8090` | where the dashboard listens |
| `--db` | `~/.logos-dashboard/<name>.db` | SQLite file |
| `--poll` | `5` | API poll interval (seconds) |
| `--keep-block-json` | `2000` | keep full JSON of canonical blocks only for the newest N heights (fork blocks are always kept; older canonical blocks are fetched from the node on click; `0` keeps everything) |
| `--metrics-cmd` | `logosctl call blockchain_module get_open_metrics` if `logosctl` is installed | command printing the node's OpenMetrics text |
| `--show-secrets` | off | serve config files without hiding secret keys |

### Keep it running (systemd user service)

Everything collected stays in SQLite, so history survives node log rotation and restarts as long as the dashboard runs.

```ini
# ~/.config/systemd/user/logos-dashboard.service
[Unit]
Description=Logos blockchain dashboard

[Service]
ExecStart=/usr/bin/python3 %h/logos-blockchain-dashboard/dashboard.py
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now logos-dashboard
loginctl enable-linger $USER   # keep running after logout
```

## Where the data comes from

| Data | Source |
|---|---|
| Every processed block, forks included, with tip/LIB after each one | `GET /cryptarchia/events/blocks/stream` (one long-lived connection the node pushes to) |
| Canonical history from before the dashboard started | `GET /cryptarchia/blocks_range`, at startup and whenever there are gaps |
| Chain state, time, peers, blend, mempool, PoW, version | polls of `/cryptarchia/info`, `/time/info`, `/network/info`, `/blend/info`, `/mempool/view`, `/pow/status` (once the chain is online), `/version` |
| Block details on click | `/cryptarchia/blocks/<id>`, `/cryptarchia/blocks/<id>/events` |
| Phases, IBD, recovery, chain sync, proposals, PoW, blend, SDP, epochs, every warning/error, exact block times | node log files, read incrementally every 10 s (rotated and `.gz` too). Rules: [`logrules.py`](logrules.py). When the rules change, log files still on disk are re-read. |
| Node metrics (optional) | `--metrics-cmd`, if `tracing.metrics.enable_open_metrics: true` |
| Config | YAML files in the node folder (and one level below); `node_key`, KMS `!Zk`/`!Ed25519` values, keystore `secret_keys` and other secret-looking keys are hidden |

## More detail from the logs (DEBUG)

At the default `INFO` level the node does not log per-block events, so block times fall back to when the dashboard received the block from the node's stream (marked `≈`). For exact receive/apply times per block and the plots marked "(DEBUG)", raise the global level **and** add target filters in `user_config.yaml`, then restart the node:

```yaml
tracing:
  filter: !Env
    filters:
      # keep the existing entries ('*': WARN, logos_blockchain: INFO, ...) and add:
      logos_blockchain::chain::service: DEBUG      # block received (exact time), startup replay progress, forky LIB advances
      logos_blockchain::chain::network: DEBUG      # block applied (exact time), orphans, future blocks, sync requests
      logos_blockchain::chain::leader: DEBUG       # leader slot wins
      logos_blockchain::cryptarchia::engine: DEBUG # fork pruning
  level: DEBUG   # global cap: without it no DEBUG line is emitted, whatever the filters say
```

Optional, noisier: `logos_blockchain::blend::service::core: DEBUG` (messages per release window), `logos_blockchain::mempool: DEBUG`, `logos_blockchain::wallet::service: DEBUG`, `logos_blockchain::network_service: TRACE` (peer connects; also needs `level: TRACE`). With `chain::network` at DEBUG, IBD logs thousands of lines per minute.

## Security

- The dashboard listens on all interfaces by default (`--host 0.0.0.0`) and has no authentication. Use `--host 127.0.0.1` plus an SSH tunnel if the network is not trusted.
- It never writes to the node. Secret keys in config files are hidden unless `--show-secrets` is given.
- The node's own API (with Swagger UI at `/swagger-ui/`) usually listens on `127.0.0.1:8080` only; use `ssh -L 8080:127.0.0.1:8080 <host>` to reach it from another machine.

## License

[MIT](LICENSE)
