// Plot definitions per tab. Each plot: {title, sub?, wide?, render(el, ctx)}.
// ctx.get(path) is a per-refresh cached JSON fetch.

const S = (i) => `--series-${i}`;
const DEBUG_HINT = "Not logged at INFO. Enable DEBUG for this target in user_config.yaml (tracing filter) to populate.";

async function events(ctx, kinds) {
  const rows = await ctx.get(`/api/events?kinds=${kinds.join(",")}&since=${ctx.since()}&limit=50000`);
  return rows.slice().reverse(); // oldest first
}

// Time extent: the selected range, tightened to where the data starts.
function span(ctx, pts) {
  const xmax = Date.now();
  const first = pts.length ? Math.min(...pts) : null;
  let xmin = ctx.since() || first || xmax - 3600e3;
  if (first != null && first > xmin) xmin = Math.max(xmin, first - (xmax - first) * 0.03 - 60e3);
  return [xmin, xmax];
}

// Count events per time bucket, stacked by group.
async function countBars(el, ctx, groups, opts = {}) {
  const kinds = [...new Set(groups.flatMap((g) => g.kinds))];
  const rows = await events(ctx, kinds);
  const [xmin, xmax] = span(ctx, rows.map((r) => r.ts));
  const b = ctx.pickBucket(xmax - xmin, 70);
  const stacks = groups.map((g) => {
    const sel = rows.filter((r) => g.kinds.includes(r.kind) && (!g.filter || g.filter(r)));
    const m = new Map();
    for (const r of sel) {
      const k = Math.floor(r.ts / b) * b;
      m.set(k, (m.get(k) || 0) + (g.weight ? g.weight(r) : 1));
    }
    return { name: g.name, color: ctx.css(g.color), values: m };
  }).filter((s) => s.values.size || opts.keepEmpty);
  if (!stacks.length) return ctx.stackedBars(el, [], [], { emptyMsg: opts.emptyMsg || "No matching log events in this range." });
  ctx.stackedBars(el, ctx.bucketRange(xmin, xmax, b), stacks, { bucketMs: b, ...opts });
  const note = document.createElement("div");
  note.className = "viz-note";
  note.textContent = `per ${fmtBucket(b)} · ${stacks.map((s) => `${s.name}: ${[...s.values.values()].reduce((a, v) => a + v, 0)}`).join(" · ")}`;
  el.appendChild(note);
}

function fmtBucket(ms) {
  if (ms < 60e3) return ms / 1e3 + "s";
  if (ms < 3600e3) return ms / 60e3 + " min";
  if (ms < 86400e3) return ms / 3600e3 + " h";
  return ms / 86400e3 + " d";
}

// Discrete events on lanes; hover shows the log line, click jumps to a block if any.
async function timeline(el, ctx, lanes, opts = {}) {
  const kinds = [...new Set(lanes.flatMap((l) => l.kinds))];
  const rows = await events(ctx, kinds);
  const groups = lanes.map((l, i) => ({
    name: l.name,
    color: ctx.css(l.color),
    points: rows.filter((r) => l.kinds.includes(r.kind)).map((r) => ({
      x: r.ts, y: lanes.length - i, label: ctx.fmtDateTime(r.ts),
      detail: [{ value: r.kind, label: r.msg.slice(0, 140) }],
      onClick: blockOf(r) ? () => ctx.selectBlock(blockOf(r)) : null,
    })),
  }));
  const [xmin, xmax] = span(ctx, rows.map((r) => r.ts));
  ctx.scatter(el, groups, {
    xmin, xmax, zero: true, ymax: lanes.length + 0.3, height: opts.height || 40 + lanes.length * 26, r: 5,
    yTicks: lanes.map((_, i) => i + 1),
    marginLeft: Math.max(52, 14 + 6.3 * Math.max(...lanes.map((l) => l.name.length))),
    yFmt: (v) => (Number.isInteger(v) && v >= 1 && v <= lanes.length ? lanes[lanes.length - v].name : ""),
    emptyMsg: opts.emptyMsg || "No matching log events in this range.",
  });
}

function blockOf(r) {
  return r.fields?.block_id || (r.msg.match(/[0-9a-f]{64}/) || [])[0];
}

// A numeric field of matching events as a line.
async function fieldLines(el, ctx, defs, opts = {}) {
  const kinds = [...new Set(defs.flatMap((d) => d.kinds))];
  const rows = await events(ctx, kinds);
  const series = defs.map((d) => ({
    name: d.name, color: ctx.css(d.color), step: d.step !== false, dots: d.dots,
    points: rows.filter((r) => d.kinds.includes(r.kind)).map((r) => [r.ts, +(typeof d.field === "function" ? d.field(r) : r.fields[d.field])]).filter((p) => Number.isFinite(p[1])),
  }));
  const [xmin, xmax] = span(ctx, rows.map((r) => r.ts));
  ctx.lineChart(el, series, { xmin, xmax, emptyMsg: opts.emptyMsg || "No matching log events in this range.", ...opts });
}

async function samples(el, ctx, defs, opts = {}) {
  const data = await ctx.get(`/api/series?since=${ctx.since()}&names=${defs.map((d) => encodeURIComponent(d.series)).join(",")}`);
  ctx.lineChart(el, defs.map((d) => ({
    name: d.name, color: ctx.css(d.color), step: d.step, points: (data[d.series] || []).map(([t, v]) => [t, d.map ? d.map(v) : v]),
  })), { emptyMsg: opts.emptyMsg || "No samples yet (needs the node API).", ...opts });
}

// Small multiples for every sample series with a given prefix that changes over time.
async function sampleFamily(el, ctx, prefix, opts = {}) {
  const names = (await ctx.get("/api/series_names")).filter((n) => n.startsWith(prefix) && !(opts.exclude || []).some((x) => n.includes(x)));
  el.replaceChildren();
  if (!names.length) {
    const d = document.createElement("div");
    d.className = "viz-empty";
    d.textContent = opts.emptyMsg || `No ${prefix}* samples.`;
    return el.appendChild(d);
  }
  const data = await ctx.get(`/api/series?since=${ctx.since()}&names=${names.map(encodeURIComponent).join(",")}`);
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px";
  el.appendChild(grid);
  let shown = 0;
  for (const n of names) {
    const pts = data[n] || [];
    if (!pts.length) continue;
    const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    if (opts.onlyChanging && lo === hi) continue;
    const cell = document.createElement("div");
    const t = document.createElement("div");
    t.className = "viz-note";
    t.textContent = `${n.slice(prefix.length)} · now ${ctx.fmtNum(pts[pts.length - 1][1])}`;
    cell.appendChild(t);
    const c = document.createElement("div");
    cell.appendChild(c);
    grid.appendChild(cell);
    requestAnimationFrame(() => ctx.lineChart(c, [{ name: n, points: pts, color: ctx.css(S(1)), step: true }], { height: 110, zero: false }));
    if (++shown >= (opts.max || 24)) break;
  }
  if (!shown) {
    const d = document.createElement("div");
    d.className = "viz-empty";
    d.textContent = "All values constant in this range.";
    el.appendChild(d);
  }
}

async function blocks(ctx) {
  return ctx.get("/api/blocks");
}

function eventTable(el, ctx, rows, cols) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap short";
  el.replaceChildren(wrap);
  ctx.table(wrap, cols || [
    { name: "time", get: (r) => ctx.fmtDateTime(r.ts) },
    { name: "kind", get: (r) => r.kind },
    { name: "message", get: (r) => r.msg, cls: "msg" },
  ], rows.slice().reverse(), (r) => blockOf(r) && ctx.selectBlock(blockOf(r)));
}

const PHASE_NAMES = ["Genesis wait", "IBD", "PBP", "Following"];

// Op groups for stacked charts: few enough colors to stay distinguishable.
const OP_GROUPS = [
  { name: "Transfer", codes: ["0"], color: S(1) },
  { name: "ClaimPowReward", codes: ["64"], color: S(2) },
  { name: "Channel (config/inscribe/deposit/withdraw/transfer)", codes: ["16", "17", "18", "19", "20"], color: S(3) },
  { name: "SDP (declare/withdraw/active)", codes: ["32", "33", "34"], color: S(4) },
  { name: "LeaderClaim", codes: ["48"], color: S(7) },
];

// Canonical blocks within the range, positioned at their slot time.
async function canonicalByTime(ctx) {
  const b = await blocks(ctx);
  const s = ctx.since();
  return b.rows.filter((r) => r[5]).map((r) => ({ r, t: ctx.slotTime(r[0]) })).filter((x) => x.t && x.t >= s);
}

function timeBuckets(ctx, items, target = 70) {
  const [xmin, xmax] = span(ctx, items.map((x) => x.t));
  const b = ctx.pickBucket(xmax - xmin, target);
  return { xmin, xmax, b, buckets: ctx.bucketRange(xmin, xmax, b) };
}

export const PLOT_TABS = {
  activity: [
    {
      title: "Operations per bucket by type",
      sub: "Canonical blocks at their slot time, so this covers the full history, not just what the dashboard saw live.",
      wide: true,
      render: async (el, ctx) => {
        const items = await canonicalByTime(ctx);
        const { b, buckets } = timeBuckets(ctx, items, 90);
        const stacks = OP_GROUPS.map((g) => ({ name: g.name, color: ctx.css(g.color), values: new Map() }));
        for (const { r, t } of items) {
          const k = Math.floor(t / b) * b;
          for (const [code, n] of Object.entries(r[8] || {})) {
            const gi = OP_GROUPS.findIndex((g) => g.codes.includes(code));
            const st = stacks[gi < 0 ? 0 : gi];
            st.values.set(k, (st.values.get(k) || 0) + n);
          }
        }
        ctx.stackedBars(el, items.length ? buckets : [], stacks.filter((x) => x.values.size), { bucketMs: b, height: 260 });
      },
    },
    {
      title: "Canonical blocks per bucket",
      sub: "Block production rate over the whole history.",
      render: async (el, ctx) => {
        const items = await canonicalByTime(ctx);
        const { b, buckets } = timeBuckets(ctx, items);
        const m = ctx.bucketize(items.map((x) => x.t), b);
        ctx.stackedBars(el, items.length ? buckets : [], [{ name: "blocks", color: ctx.css(S(1)), values: m }], { bucketMs: b, emptyMsg: "No canonical blocks in this range." });
      },
    },
    {
      title: "Block size",
      sub: "Serialized JSON size of each block as served by the node API (bytes).",
      render: async (el, ctx) => {
        const items = (await canonicalByTime(ctx)).filter((x) => x.r[9]);
        const step = Math.max(1, Math.floor(items.length / 3000));
        ctx.scatter(el, [{
          name: "block size", color: ctx.css(S(1)),
          points: items.filter((_, i) => i % step === 0).map(({ r, t }) => ({ x: t, y: r[9], label: `height ${r[1]} · slot ${r[0]}`, detail: [{ value: r[3], label: "transactions" }], onClick: () => ctx.selectBlock(r[7]) })),
        }], { r: 2.5, yFmt: (v) => ctx.fmtNum(v) + "B" });
      },
    },
    {
      title: "Transactions per block",
      render: async (el, ctx) => ctx.histogram(el, (await canonicalByTime(ctx)).map((x) => x.r[3]), { name: "blocks", integer: true, min: 0, bins: 40 }),
    },
    {
      title: "Operation totals in range",
      render: async (el, ctx) => {
        const items = await canonicalByTime(ctx);
        const tot = {};
        for (const { r } of items) for (const [c, n] of Object.entries(r[8] || {})) tot[c] = (tot[c] || 0) + n;
        const all = Object.values(tot).reduce((a, v) => a + v, 0);
        const rows = Object.entries(tot).sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ c, n }));
        const wrap = document.createElement("div");
        wrap.className = "table-wrap short";
        el.replaceChildren(wrap);
        ctx.table(wrap, [
          { name: "opcode", get: (x) => "0x" + (+x.c).toString(16).padStart(2, "0"), cls: "msg" },
          { name: "operation", get: (x) => ctx.OP_NAMES[x.c] || "unknown" },
          { name: "count", get: (x) => x.n.toLocaleString(), cls: "num" },
          { name: "share", get: (x) => ((100 * x.n) / all).toFixed(1) + "%", cls: "num" },
        ], rows);
      },
    },
    {
      title: "Biggest blocks in range",
      render: async (el, ctx) => {
        const items = (await canonicalByTime(ctx)).sort((a, b) => (b.r[9] || 0) - (a.r[9] || 0)).slice(0, 50);
        const wrap = document.createElement("div");
        wrap.className = "table-wrap short";
        el.replaceChildren(wrap);
        ctx.table(wrap, [
          { name: "height", get: (x) => x.r[1], cls: "num" },
          { name: "slot", get: (x) => x.r[0], cls: "num" },
          { name: "txs", get: (x) => x.r[3], cls: "num" },
          { name: "size", get: (x) => ctx.fmtNum(x.r[9]) + "B", cls: "num" },
          { name: "time", get: (x) => ctx.fmtDateTime(x.t) },
        ], items, (x) => ctx.selectBlock(x.r[7]));
      },
    },
  ],

  chain: [
    {
      title: "Tip, LIB and wall-clock slot",
      sub: "From /cryptarchia/info and /time/info polls. The gap between the wall-clock and tip lines is how far behind the node is.",
      render: (el, ctx) => samples(el, ctx, [
        { name: "wall-clock slot", series: "time.current_slot", color: S(3) },
        { name: "tip slot", series: "cryptarchia.cryptarchia_info.slot", color: S(1) },
        { name: "LIB slot", series: "cryptarchia.cryptarchia_info.lib_slot", color: S(7) },
      ], { zero: false }),
    },
    {
      title: "Chain phase",
      sub: "AwaitingGenesis → IBD (initial block download) → PBP (prolonged bootstrap) → Following",
      render: (el, ctx) => samples(el, ctx, [{ name: "phase", series: "cryptarchia.phase_code", color: S(1), step: true }], {
        yFmt: (v) => PHASE_NAMES[v] ?? "", height: 160, ymin: 0, ymax: 3.2, yTicks: [0, 1, 2, 3], marginLeft: 82,
      }),
    },
    {
      title: "Bootstrap, IBD & recovery timeline",
      sub: "From log lines; click a point to see the line.",
      wide: true,
      render: (el, ctx) => timeline(el, ctx, [
        { name: "node start / stop", kinds: ["node_start", "node_panic", "node_shutdown", "service_start_timeout"], color: S(8) },
        { name: "phase", kinds: ["phase_enter", "genesis_future", "genesis_past"], color: S(1) },
        { name: "recovery", kinds: ["recovery_start", "recovery_loading", "recovery_found", "recovery_done", "recovery_fallback"], color: S(7) },
        { name: "IBD", kinds: ["ibd_start", "ibd_complete", "ibd_skipped", "ibd_failed"], color: S(3) },
        { name: "IBD tip fetch fail", kinds: ["ibd_tip_fetch_failed", "ibd_download_cancelled"], color: S(8) },
        { name: "online", kinds: ["pbp_complete", "chain_online", "offline_grace"], color: S(6) },
        { name: "tip-poll catch-up", kinds: ["tip_poll_catchup", "tip_poll_lagging"], color: S(2) },
      ]),
    },
    {
      title: "Startup recovery: stored blocks replayed",
      sub: "On restart the node replays the blocks it stored after LIB before it serves anything (DEBUG on chain::service shows progress; the API is down meanwhile).",
      render: (el, ctx) => fieldLines(el, ctx, [
        { name: "replayed", kinds: ["recovery_progress"], field: "i", color: S(7), step: false },
        { name: "to replay", kinds: ["recovery_found", "recovery_progress"], field: (r) => r.fields.total ?? r.fields.n, color: S(4) },
      ], { emptyMsg: "No recovery progress lines in this range (needs DEBUG on logos_blockchain::chain::service)." }),
    },
    {
      title: "Blocks applied by the node",
      sub: "Bucketed by when the node processed each block: its DEBUG log line (exact) when available, else when the node pushed the block to the dashboard (≈ ms later). During IBD this is the download rate.",
      render: async (el, ctx) => {
        const b = await blocks(ctx);
        const s = ctx.since();
        const live = b.rows.filter((r) => r[2] && r[2] >= s);
        const [xmin, xmax] = span(ctx, live.map((r) => r[2]));
        const bk = ctx.pickBucket(xmax - xmin, 70);
        const groups = [
          { name: "IBD", color: "--series-7", f: (r) => r[10] === "IBD" },
          { name: "PBP", color: "--series-5", f: (r) => r[10] === "PBP" },
          { name: "Following", color: "--series-3", f: (r) => r[10] === "Following" },
          { name: "other / unknown phase", color: "--muted", f: (r) => !["IBD", "PBP", "Following"].includes(r[10]) },
        ];
        const stacks = groups.map((g) => ({ name: g.name, color: ctx.css(g.color), values: ctx.bucketize(live.filter(g.f).map((r) => r[2]), bk) }))
          .filter((x) => x.values.size);
        ctx.stackedBars(el, live.length ? ctx.bucketRange(xmin, xmax, bk) : [], stacks, { bucketMs: bk, emptyMsg: "No blocks applied while the dashboard was running in this range." });
      },
    },
    {
      title: "Block arrival delay (following live)",
      sub: "Slot start → node applied the block (node log time when DEBUG is on, else dashboard receive time), for blocks applied outside IBD. Blocks more than 30 s late are counted separately: those come from catch-up (tip poll / orphan sync), not from normal propagation.",
      render: async (el, ctx) => {
        const b = await blocks(ctx);
        const s = ctx.since();
        const d = b.rows.filter((r) => r[2] && r[2] >= s && r[5] && r[10] && r[10] !== "IBD")
          .map((r) => (r[2] - ctx.slotTime(r[0])) / 1000).filter((v) => Number.isFinite(v));
        const onTime = d.filter((v) => v <= 30);
        ctx.histogram(el, onTime, { name: "blocks", min: 0, max: Math.max(2, Math.min(30, Math.max(...onTime, 0))), bins: 30, xFmt: (v) => v.toFixed(1) + "s", emptyMsg: "No blocks applied live outside IBD yet." });
        const late = d.length - onTime.length;
        if (d.length) {
          const note = document.createElement("div");
          note.className = "viz-note";
          const exact = b.rows.filter((r) => r[2] && r[2] >= s && r[5] && r[10] && r[10] !== "IBD" && r[11] !== "stream").length;
          note.textContent = `${late} of ${d.length} blocks arrived more than 30 s after their slot (catch-up) · ${exact} timed from node logs, ${d.length - exact} from dashboard receive time`;
          el.appendChild(note);
        }
      },
    },
    {
      title: "Arrival delay over time",
      sub: "Each dot is a block applied outside IBD; y = seconds after its slot started (values above 120 s are drawn at 120 s). Bursts of late blocks mean the node fell behind and caught up.",
      render: async (el, ctx) => {
        const b = await blocks(ctx);
        const s = ctx.since();
        const rows = b.rows.filter((r) => r[2] && r[2] >= s && r[10] && r[10] !== "IBD");
        const pt = (r) => {
          const v = (r[2] - ctx.slotTime(r[0])) / 1000;
          return { x: r[2], y: Math.min(v, 120), label: `height ${r[1]} · slot ${r[0]}`, detail: [{ value: v.toFixed(2) + "s", label: "arrival delay" }], onClick: () => ctx.selectBlock(r[7]) };
        };
        ctx.scatter(el, [
          { name: "canonical", color: ctx.css(S(1)), points: rows.filter((r) => r[5]).map(pt) },
          { name: "fork", color: ctx.css(S(2)), points: rows.filter((r) => !r[5]).map(pt) },
        ], { r: 3, yFmt: (v) => v + "s", emptyMsg: "No blocks applied live outside IBD yet." });
      },
    },
    {
      title: "Block processing time (DEBUG)",
      sub: "From “Received proposal” (chain::service) to “block applied” (chain::network) for the same block. Needs DEBUG on both targets.",
      render: async (el, ctx) => {
        const b = await blocks(ctx);
        const s = ctx.since();
        const v = b.rows.filter((r) => r[12] && r[13] && r[12] >= s).map((r) => r[13] - r[12]).filter((x) => x >= 0);
        ctx.histogram(el, v, { name: "blocks", min: 0, bins: 30, xFmt: (x) => Math.round(x) + "ms", emptyMsg: DEBUG_HINT + " Targets: logos_blockchain::chain::service and ::chain::network" });
      },
    },
    {
      title: "Slots between consecutive canonical blocks",
      sub: "All known canonical blocks. Shape follows the leader-election rate (active slot coefficient).",
      render: async (el, ctx) => {
        const b = await blocks(ctx);
        const c = b.rows.filter((r) => r[5]).map((r) => r[0]);
        const gaps = [];
        for (let i = 1; i < c.length; i++) gaps.push(c[i] - c[i - 1]);
        ctx.histogram(el, gaps, { name: "blocks", bins: 40, min: 1, integer: true });
      },
    },
    {
      title: "Canonical blocks vs time",
      sub: "Each dot is a canonical block at its slot time; y = transactions. Click to inspect.",
      render: async (el, ctx) => {
        const b = await blocks(ctx);
        const s = ctx.since();
        const pts = b.rows.filter((r) => r[5]).map((r) => ({ r, t: ctx.slotTime(r[0]) })).filter((x) => x.t && x.t >= s);
        ctx.scatter(el, [
          { name: "txs per block", color: ctx.css(S(1)), points: pts.map(({ r, t }) => ({ x: t, y: r[3], label: `height ${r[1]} · slot ${r[0]}`, onClick: () => ctx.selectBlock(r[7]) })) },
        ], { r: 3 });
      },
    },
    {
      title: "Sync lag: wall-clock slot − tip slot",
      sub: "How far the node's tip is behind the current slot. Near 0 when synced; spikes between blocks are normal (blocks are ~30 slots apart).",
      render: (el, ctx) => samples(el, ctx, [{ name: "slots behind", series: "cryptarchia.slots_behind", color: S(2) }]),
    },
    {
      title: "LIB depth: tip slot − LIB slot",
      sub: "LIB stays put while Bootstrapping (often still genesis), so this grows with the tip; once Online LIB is the k-th ancestor of the tip and this becomes a small steady gap.",
      render: (el, ctx) => samples(el, ctx, [{ name: "tip slot − LIB slot", series: "cryptarchia.tip_minus_lib_slots", color: S(7) }]),
    },
    {
      title: "Reorgs (live) and forky LIB advances (logs)",
      sub: "Reorg depth = blocks of the old tip's branch that were abandoned.",
      render: async (el, ctx) => {
        const ce = (await ctx.get(`/api/chain_events?since=${ctx.since()}`)).filter((e) => e.kind === "reorg");
        const lib = await events(ctx, ["lib_advanced"]);
        const [xmin, xmax] = span(ctx, ce.map((e) => e.ts));
        ctx.scatter(el, [
          { name: "reorg depth (live)", color: ctx.css(S(2)), points: ce.map((e) => ({ x: e.ts, y: e.depth || 0, label: ctx.fmtDateTime(e.ts), onClick: () => ctx.selectBlock(e.new) })) },
          { name: "reorged blocks at LIB advance (log, D)", color: ctx.css(S(7)), points: lib.filter((r) => +r.fields.reorged).map((r) => ({ x: r.ts, y: +r.fields.reorged, label: ctx.fmtDateTime(r.ts), detail: [{ value: r.fields.stale, label: "stale blocks pruned" }] })) },
        ], { xmin, xmax, emptyMsg: "No reorgs observed in this range." });
      },
    },
    {
      title: "Rejected blocks by reason",
      sub: "ERROR “Failed to process block: …” lines. ParentMissing = orphan, AlreadyApplied = duplicate.",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "ParentMissing", kinds: ["block_rejected"], filter: (r) => r.fields.error === "ParentMissing", color: S(4) },
        { name: "AlreadyApplied", kinds: ["block_rejected"], filter: (r) => r.fields.error === "AlreadyApplied", color: S(3) },
        { name: "other", kinds: ["block_rejected"], filter: (r) => !["ParentMissing", "AlreadyApplied"].includes(r.fields.error), color: S(8) },
        { name: "reconstruct/processing errors", kinds: ["block_reconstruct_failed", "block_processing_error"], color: S(7) },
      ]),
    },
    {
      title: "Chain sync & orphan handling",
      sub: "Orphan downloads and requests are DEBUG; queue overflow, tip timeouts and sync errors are logged at WARN/ERROR.",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "orphan enqueued / parent missing (D)", kinds: ["orphan_enqueued", "orphan_parent_missing"], color: S(1) },
        { name: "orphan downloads (D)", kinds: ["orphan_download_start", "orphan_sync_done"], color: S(3) },
        { name: "orphan queue full", kinds: ["orphan_ignored"], color: S(4) },
        { name: "tip-poll catch-up", kinds: ["tip_poll_catchup"], color: S(2) },
        { name: "sync errors / timeouts", kinds: ["orphan_error", "sync_tip_timeout", "sync_net_error", "sync_serve_error", "ibd_tip_fetch_failed"], color: S(8) },
        { name: "peer requests dropped (chain busy)", kinds: ["sync_event_dropped"], color: S(5) },
        { name: "block/tip requests to peers (D)", kinds: ["sync_request", "sync_tip_request", "ibd_collecting_tips"], color: S(6) },
        { name: "serving peers (D)", kinds: ["sync_serve"], color: S(7) },
      ]),
    },
    {
      title: "Blocks received by the chain service (DEBUG)",
      sub: DEBUG_HINT + " Target: logos_blockchain::chain::service",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "received", kinds: ["block_received"], color: S(1) },
        { name: "applied (chain-network)", kinds: ["block_applied"], color: S(3) },
        { name: "future slot", kinds: ["future_block"], color: S(4) },
      ], { emptyMsg: DEBUG_HINT }),
    },
    {
      title: "Epoch transitions: total stake",
      render: (el, ctx) => fieldLines(el, ctx, [{ name: "new total stake", kinds: ["epoch_transition"], field: "new_total_stake", color: S(1), dots: true }]),
    },
  ],

  leader: [
    {
      title: "Blocks proposed by this node",
      sub: "INFO “proposed block …”, split by whether the block is on the canonical chain now.",
      render: async (el, ctx) => {
        const b = await blocks(ctx);
        const canon = new Set(b.rows.filter((r) => r[5]).map((r) => r[7]));
        const known = new Set(b.rows.map((r) => r[7]));
        await countBars(el, ctx, [
          { name: "canonical", kinds: ["block_proposed"], filter: (r) => canon.has(r.fields.block_id), color: S(1) },
          { name: "orphaned / forked", kinds: ["block_proposed"], filter: (r) => known.has(r.fields.block_id) && !canon.has(r.fields.block_id), color: S(2) },
          { name: "not in dashboard DB", kinds: ["block_proposed"], filter: (r) => !known.has(r.fields.block_id), color: S(4) },
          { name: "own block failed", kinds: ["own_block_failed"], color: S(8) },
        ], { emptyMsg: "No “proposed block” lines in this range." });
      },
    },
    {
      title: "Own proposals",
      sub: "Click a row to open the block.",
      render: async (el, ctx) => eventTable(el, ctx, await events(ctx, ["block_proposed", "own_block_failed", "leadership_proof_failure"]), [
        { name: "time", get: (r) => ctx.fmtDateTime(r.ts) },
        { name: "kind", get: (r) => r.kind },
        { name: "block", get: (r) => ctx.idCell(r.fields.block_id), cls: "nowrap" },
        { name: "txs", get: (r) => r.fields.txs ?? "", cls: "num" },
        { name: "removed", get: (r) => r.fields.removed ?? "", cls: "num" },
      ]),
    },
    {
      title: "Leader slot wins (DEBUG)",
      sub: DEBUG_HINT + " Target: logos_blockchain::chain::leader::leadership",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "won slot", kinds: ["leader_won"], color: S(6) },
        { name: "proposed", kinds: ["block_proposed"], color: S(1) },
        { name: "proof / leader errors", kinds: ["leadership_proof_failure", "leader_error", "leader_blend_relay_failed"], color: S(8) },
      ]),
    },
    {
      title: "PoW: tickets mined and claims",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "tickets mined", kinds: ["pow_ticket"], color: S(1) },
        { name: "rewards claimed", kinds: ["pow_claimed"], weight: (r) => +r.fields.n || 1, color: S(3) },
        { name: "claims settled", kinds: ["pow_retired"], weight: (r) => +r.fields.n || 1, color: S(7) },
        { name: "tickets expired", kinds: ["pow_pruned"], weight: (r) => +r.fields.n || 1, color: S(4) },
        { name: "errors", kinds: ["pow_error"], color: S(8) },
      ], { emptyMsg: "No PoW log lines in this range (is mining on?)." }),
    },
    {
      title: "PoW: claimable / pending tickets",
      sub: "Values reported by the PoW service in its log lines.",
      render: (el, ctx) => fieldLines(el, ctx, [
        { name: "claimable tickets", kinds: ["pow_ticket"], field: "claimable", color: S(1) },
        { name: "ready after claim", kinds: ["pow_claimed", "pow_pool_spent"], field: "ready", color: S(3) },
        { name: "claims pending settlement", kinds: ["pow_retired"], field: "pending", color: S(7) },
      ]),
    },
    {
      title: "PoW state changes",
      wide: true,
      render: (el, ctx) => timeline(el, ctx, [
        { name: "mining", kinds: ["pow_mining_started", "pow_mining_stopped"], color: S(1) },
        { name: "auto-claim", kinds: ["pow_autoclaim_started", "pow_autoclaim_stopped", "pow_autoclaim_not_started", "pow_targets_reached"], color: S(3) },
        { name: "claims", kinds: ["pow_claimed", "pow_no_rewards", "pow_pool_spent"], color: S(7) },
        { name: "errors", kinds: ["pow_error"], color: S(8) },
      ]),
    },
    {
      title: "PoW status (node API /pow/status)",
      wide: true,
      render: (el, ctx) => sampleFamily(el, ctx, "pow.", { emptyMsg: "No /pow/status samples." }),
    },
    {
      title: "SDP activity",
      wide: true,
      render: (el, ctx) => timeline(el, ctx, [
        { name: "declaration", kinds: ["sdp_declaration_submitted"], color: S(1) },
        { name: "activity submitted", kinds: ["sdp_activity_submitted", "blend_activity_proof"], color: S(3) },
        { name: "activity committed", kinds: ["sdp_activity_committed"], color: S(6) },
        { name: "failures", kinds: ["sdp_activity_failed", "blend_activity_proof_failed"], color: S(8) },
      ]),
    },
  ],

  blend: [
    {
      title: "Blend mode & membership",
      wide: true,
      render: (el, ctx) => timeline(el, ctx, [
        { name: "mode changed", kinds: ["blend_mode_changed"], color: S(1) },
        { name: "membership ready", kinds: ["blend_membership_ready", "blend_membership_rebuilt"], color: S(3) },
        { name: "retiring / shutdown", kinds: ["blend_retiring"], color: S(4) },
        { name: "swarm started", kinds: ["blend_swarm_started"], color: S(7) },
      ]),
    },
    {
      title: "Membership size",
      render: (el, ctx) => fieldLines(el, ctx, [{ name: "members", kinds: ["blend_membership_ready", "blend_membership_rebuilt"], field: (r) => r.fields.members ?? r.fields.membership_count, color: S(1) }]),
    },
    {
      title: "Core connections vs protocol target",
      sub: "From “Holding fewer connections…” / “Back to the connections…” lines.",
      render: (el, ctx) => fieldLines(el, ctx, [
        { name: "live", kinds: ["blend_conn_low", "blend_conn_ok"], field: "live", color: S(1) },
        { name: "wanted", kinds: ["blend_conn_low"], field: "wanted", color: S(3) },
        { name: "opened by this node", kinds: ["blend_conn_low", "blend_conn_ok"], field: "dialed", color: S(7) },
      ]),
    },
    {
      title: "Blend problems",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "dial errors", kinds: ["blend_dial_error", "blend_negotiation_failure"], color: S(4) },
        { name: "send failures", kinds: ["blend_send_failure", "blend_edge_drop"], color: S(8) },
        { name: "delivery fallback (broadcast in clear)", kinds: ["blend_delivery_fallback", "blend_missed_broadcast"], color: S(2) },
        { name: "lagged / dropped", kinds: ["blend_lagged", "blend_dropped_proposals"], color: S(5) },
        { name: "quota exhausted", kinds: ["blend_quota_exhausted"], color: S(7) },
        { name: "network too small", kinds: ["blend_min_network"], color: S(3) },
        { name: "PoQ / PoL / epoch state", kinds: ["blend_poq_failed", "blend_pol_check", "blend_epoch_state_error"], color: S(1) },
      ]),
    },
    {
      title: "Messages per release window (DEBUG)",
      sub: DEBUG_HINT + " Target: logos_blockchain::blend::service::core",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "data", kinds: ["blend_release"], weight: (r) => +r.fields.data, color: S(1) },
        { name: "processed", kinds: ["blend_release"], weight: (r) => +r.fields.processed, color: S(3) },
        { name: "cover", kinds: ["blend_release"], weight: (r) => +r.fields.cover, color: S(7) },
      ], { emptyMsg: DEBUG_HINT }),
    },
    {
      title: "Edge messages sent",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "sent", kinds: ["blend_edge_sent"], color: S(1) },
        { name: "dropped", kinds: ["blend_edge_drop"], color: S(8) },
      ], { emptyMsg: "No edge-mode messages in this range." }),
    },
    {
      title: "Blend info (node API /blend/info)",
      wide: true,
      render: (el, ctx) => sampleFamily(el, ctx, "blend.", { emptyMsg: "No /blend/info samples (blend may not be running)." }),
    },
    {
      title: "Blend mode changes",
      wide: true,
      render: async (el, ctx) => eventTable(el, ctx, await events(ctx, ["blend_mode_changed", "blend_membership_ready", "blend_retiring", "blend_min_network"])),
    },
  ],

  network: [
    {
      title: "Peers and connections",
      render: (el, ctx) => samples(el, ctx, [
        { name: "peers", series: "network.n_peers", color: S(1), step: true },
        { name: "connections", series: "network.n_connections", color: S(3), step: true },
        { name: "pending", series: "network.n_pending_connections", color: S(4), step: true },
      ]),
    },
    {
      title: "Peer connects / disconnects (TRACE)",
      sub: "Only logged at TRACE for logos_blockchain::network_service.",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "connected", kinds: ["peer_connected"], color: S(1) },
        { name: "disconnected", kinds: ["peer_disconnected"], color: S(2) },
        { name: "dial failed (D)", kinds: ["dial_failed"], color: S(8) },
      ]),
    },
    {
      title: "Network events",
      wide: true,
      render: (el, ctx) => timeline(el, ctx, [
        { name: "start / routing", kinds: ["net_started", "routing_complete"], color: S(1) },
        { name: "kademlia", kinds: ["kad_mode", "kad_closest_failed"], color: S(7) },
        { name: "NAT", kinds: ["nat_ok", "nat_failed"], color: S(3) },
        { name: "gossip / lagged", kinds: ["gossip_oversized", "net_lagged"], color: S(4) },
        { name: "NTP", kinds: ["ntp_failed", "ntp_backwards"], color: S(8) },
      ]),
    },
    {
      title: "Mempool and wallet",
      render: (el, ctx) => countBars(el, ctx, [
        { name: "wallet fell behind / errors", kinds: ["wallet_behind", "wallet_error"], color: S(8) },
        { name: "SDP fell behind", kinds: ["sdp_behind"], color: S(4) },
        { name: "mempool adds (D)", kinds: ["mempool_added"], color: S(1) },
      ]),
    },
    {
      title: "Node metrics (OpenMetrics via logosctl)",
      sub: "Needs tracing.metrics.enable_open_metrics: true in user_config.yaml. Only series that changed are shown.",
      wide: true,
      render: (el, ctx) => sampleFamily(el, ctx, "metrics.", { onlyChanging: true, max: 36, emptyMsg: "No OpenMetrics samples. See “Collector health” on the Overview tab." }),
    },
    {
      title: "Explore any collected series",
      wide: true,
      render: async (el, ctx) => {
        const names = await ctx.get("/api/series_names");
        el.replaceChildren();
        const sel = document.createElement("select");
        for (const n of names) sel.appendChild(new Option(n, n));
        sel.value = el.dataset.sel || "network.n_peers";
        const box = document.createElement("div");
        el.append(sel, box);
        const draw = async () => {
          el.dataset.sel = sel.value;
          const d = await ctx.api(`/api/series?since=${ctx.since()}&names=${encodeURIComponent(sel.value)}`);
          ctx.lineChart(box, [{ name: sel.value, points: d[sel.value] || [], color: ctx.css(S(1)), step: true }], { zero: false });
        };
        sel.addEventListener("change", draw);
        await draw();
      },
    },
  ],
};
