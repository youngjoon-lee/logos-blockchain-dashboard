# CLAUDE.md

Guidance for working on this repo. User-facing docs are in `README.md`.

## What this is

A dashboard for one logos-blockchain node (target version 0.3.x). It runs next to the node (Raspberry Pi or a Mac), collects data into SQLite and serves a web UI. Hard constraints:

- **Python 3 standard library only** (3.9+, the Pi's system Python). No pip packages.
- **No frontend build or CDN.** Plain ES modules in `static/`, hand-written SVG charts in `static/charts.js`. Must work on a LAN without internet.
- **Read-only towards the node.** Never call endpoints that change node state (mining, claims, tracing filter, …) unless the user explicitly asks; such controls would go behind an opt-in flag like `--allow-control`.
- **Never serve secrets.** Only YAML files in the node folder are listed and served (`list_config_files`); `redact_yaml` hides secret-looking keys, KMS `!Zk`/`!Ed25519` values, keystore `secret_keys`. Any change to config display must keep that true.

## Layout

| File | Role |
|---|---|
| `dashboard.py` | everything server-side: SQLite schema (`SCHEMA`, `DB`), node API client, `Chain` (block storage, heights, canonical set, tip/LIB/reorg tracking), `Collector` (threads: block stream, backfill, polling, log tailing, metrics, storage maintenance), log parser, config redaction, HTTP server (`App` + `make_handler` routes), node/path auto-detection, `main()` |
| `logrules.py` | `RULES`: log message → event kind (first match wins; named regex groups become fields), `categorize_target`, `rules_version` |
| `static/index.html`, `style.css` | page shell, tabs, theme tokens (light/dark) |
| `static/app.js` | shell, overview, block tree (layout, phase/mode/epoch strips, block panel), logs tab, config tab, routing (`#tab`, `#block/<id>`) |
| `static/plots.js` | `PLOT_TABS`: declarative chart cards per tab (chain, activity, leader, blend, network) |
| `static/charts.js` | `lineChart`, `scatter`, `stackedBars`, `histogram`, time formatting (`fmtDateTime`, `fmtClock`, `TZ`) |
| `dev/mock_node.py`, `dev/gen_logs.py` | mock node API with forks/reorgs and synthetic logs for testing |

## Data model and flow

- **Blocks** come from `GET /cryptarchia/events/blocks/stream` (NDJSON; every processed block incl. forks, with tip/LIB after it; the first event after connecting may be a snapshot of the tip). Older canonical blocks are backfilled from `/cryptarchia/blocks_range` (descending, below each gap = stored block whose parent is not stored).
- **Heights** are not in the stream: anchors come from `/cryptarchia/info` (tip, height) and propagate through parent links (`Chain.assign_height`).
- **Block JSON** is zlib-compressed; for canonical blocks older than `--keep-block-json` heights it is dropped (the node serves it on click). Fork blocks keep it (the node prunes them). Per-block op counts (`ops`, by opcode) and `size` are kept forever for the Activity tab.
- **Tip/LIB/reorgs**: `Chain.observe_tip_lib`. A tip change is judged only once its block is stored; a "new" tip that is an ancestor of the current one is a stale observation (poll vs stream race) and is ignored; a reorg needs both sides to diverge from a common ancestor.
- **Block times**: `block_times` holds the node's exact times from DEBUG logs (`received_ms` from chain::service "Received proposal", `applied_ms` from chain::network "block applied"). Effective time `T_MS = coalesce(applied, received, seen_ms)`; `seen_ms` (dashboard receive time from the stream) is only a fallback and is shown as approximate.
- **Phases/modes**: `App.phase_intervals` builds Genesis wait/IBD/PBP/Following and Bootstrapping/Online intervals from log events (exact), falling back to polled samples. `App.block_phases` maps blocks to them by effective time; older canonical blocks inherit the phase of the next timed block within the same node run (flagged `inferred`).
- **Samples**: every numeric field of every polled API response is stored as a time series (`flatten_numbers`), so new plots rarely need backend changes. Lists are only counted (`.len`); the auto-claim targets of `/pow/status` are stored per target as `pow.target.<public key>.balance|threshold` (`pow_target_samples`). `node.uptime_s` comes from `NodeProcess` (`ps` on the local machine; 0 once a seen process is gone).
- **Logs**: read incrementally per file (offset in `log_files`), only files matching the node's log prefix; `.latest` symlinks skipped; `.gz` supported. `log_stats` and `templates` are per file so a file can be re-read alone. When `rules_version()` changes (any rule or `PARSER_VERSION`), files still on disk are re-read and events from vanished files re-classified (`rebuild_logs_if_rules_changed`). **Bump `PARSER_VERSION` when parsing logic changes** in a way rules don't capture.

## Node facts (0.3.2) this code relies on

- Log line format: tracing fmt with ANSI colors on: `TIMESTAMP(UTC, Z)  LEVEL [spans{..}:] target: message k=v ...`. Spans always carry `{fields}`, which tells them apart from the target. `HeaderId` Debug = `HeaderId(<64 hex>)`, Display = `0x<64 hex>`; `Slot(n)`, `Epoch(n)`.
- Default level is INFO for `logos_blockchain`, WARN for everything else. **`tracing.level` is a global cap** (`LevelFilter`): DEBUG target filters do nothing unless `level: DEBUG`, and the runtime `PUT /admin/tracing/filter` cannot lift it either.
- At INFO there are no per-block, per-slot or per-peer lines; PoW hashrate and leader claims are never logged.
- On startup the node replays stored blocks and logs "Received proposal" for each one (DEBUG); the parser turns those into `block_replayed` between `recovery_start` and `recovery_done` (state persisted in `meta.in_recovery`). The API is down during the replay.
- LIB does not move while the chain is Bootstrapping (`State::Bootstrapping => branches.lib`, often genesis); Online LIB = k-th ancestor of the tip.
- The PoW service only answers after the chain is Online (requests hang before), so `/pow/status` is polled only when Online.
- Mantle opcodes: 0x00 Transfer, 0x10 ChannelConfig, 0x11 ChannelInscribe, 0x12 ChannelDeposit, 0x13 ChannelWithdraw, 0x14 ChannelTransfer, 0x20 SDPDeclare, 0x21 SDPWithdraw, 0x22 SDPActive, 0x30 LeaderClaim, 0x40 ClaimPowReward.
- Node source is in the sibling repo `../logos-blockchain` (check out the release tag when verifying a log message, API shape or behavior). Log target names: `tracing/targets`; filter defaults: `tracing/src/filter/envfilter.rs`; HTTP API: `nodes/node/binary/src/api/`.
- Swagger UI: `http://127.0.0.1:8080/swagger-ui/`.

## Conventions

- Every displayed time goes through `fmtDateTime`/`fmtClock` (local timezone with its name); time axes show the zone. Raw log lines stay UTC and are labelled so.
- Charts follow the dataviz rules used so far: one y-axis per chart (split charts with different scales), categorical colors from the `--series-N` tokens in fixed order, status colors only for state, legends for 2+ series, tooltips on every chart, text in text tokens.
- Untrusted strings (log messages, API data) go into the DOM via `textContent`, never `innerHTML`.
- Plots that need DEBUG logs say so in their subtitle and empty state (`DEBUG_HINT`).
- Keep `README.md` in sync with flags and data sources.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary` with types such as `feat`, `fix`, `docs`, `ci`, `refactor`, `test`, `chore`; optional scopes like `ui`, `logs`, `collector`. One type per commit: split a commit that mixes a fix and a feature. No `Co-Authored-By` lines. Never commit, amend or rewrite history without the user's approval: show the change and the proposed message first. Never push without asking.

## Testing

CI (`.github/workflows/ci.yml`, Python 3.9 and 3.13) runs these on every push and PR; run them locally before committing:

```bash
python3 -m py_compile dashboard.py logrules.py dev/*.py
for f in static/*.js; do node --input-type=module --check < "$f"; done
python3 dev/smoke_test.py   # ~15 s: synthetic logs + mock node + real dashboard, ~30 API checks
```

`dev/smoke_test.py` asserts collection (blocks, forks, heights, tip/LIB), log rules and field extraction, phase intervals, YAML-only config listing, secret hiding, static files. Extend it when adding features. Keep the code Python 3.9 compatible (no `match`, `str.removeprefix`, `X | Y` types); `ast.parse(src, feature_version=(3, 9))` catches syntax slips.

Manual checks used so far:

```bash

# mock node + synthetic logs (forks, reorgs, rotated/.gz logs, ANSI)
python3 dev/gen_logs.py /tmp/lbd/data/node1 18080
python3 dev/mock_node.py 18080 &
python3 dashboard.py --data-dir /tmp/lbd/data/node1 --log-prefix logos-blockchain.log \
  --port 18090 --host 127.0.0.1 --db /tmp/lbd/test.db --poll 2 --metrics-cmd ''

# look at the page (headless Brave/Chrome screenshot), e.g. the block tree or one block
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=1440,1200 --virtual-time-budget=15000 \
  --screenshot=/tmp/lbd/tree.png "http://127.0.0.1:18090/#tree"
```

Also check against a real node when possible (the user runs one on the Mac and on a Pi). Static files are served from disk without caching, so frontend edits only need a browser reload; backend edits need a dashboard restart.

## Ideas not done yet

- Opt-in node controls (`--allow-control`): start/stop mining, claim, set tracing filter.
- Rules for more INFO/WARN messages as they show up in real logs (Logs tab → "Most frequent messages" shows unmatched templates; compare with `logrules.py`).
- A unit test suite for the log parser and `redact_yaml` using captured real log lines.
