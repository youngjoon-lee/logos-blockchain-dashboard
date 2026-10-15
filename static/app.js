const fmtInt = (v) => (v == null ? "–" : Number(v).toLocaleString());
export const OP_NAMES = {
  0: "Transfer", 16: "ChannelConfig", 17: "ChannelInscribe", 18: "ChannelDeposit", 19: "ChannelWithdraw",
  20: "ChannelTransfer", 32: "SDPDeclare", 33: "SDPWithdraw", 34: "SDPActive", 48: "LeaderClaim", 64: "ClaimPowReward",
};
const opName = (c) => OP_NAMES[c] || "op " + c;
import { lineChart, scatter, stackedBars, histogram, css, fmtNum, fmtTime, fmtDateTime, fmtClock, TZ, bucketize, bucketRange, pickBucket } from "./charts.js";
import { PLOT_TABS } from "./plots.js";

const $ = (s) => document.querySelector(s);
const state = {
  tab: "overview",
  range: 21600000,
  status: null,
  tree: { window: 300, toHeight: null, selected: null, data: null, zoom: null },
  configFile: null,
};

async function api(path) {
  const r = await fetch(path);
  const j = await r.json();
  if (j && j.error && !r.ok) throw new Error(j.error);
  return j;
}

function since() {
  return state.range ? Date.now() - state.range : 0;
}

function short(id, n = 8) {
  return id ? id.slice(0, n) + "…" + id.slice(-4) : "–";
}

function text(tag, t, cls) {
  const e = document.createElement(tag);
  if (t != null) e.textContent = t;
  if (cls) e.className = cls;
  return e;
}

function table(container, cols, rows, onClick) {
  container.replaceChildren();
  if (!rows.length) {
    container.appendChild(text("div", "Nothing here yet.", "viz-empty"));
    return;
  }
  const t = document.createElement("table");
  const thead = t.createTHead().insertRow();
  for (const c of cols) thead.appendChild(text("th", c.name));
  const tb = t.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    if (onClick) { tr.className = "clickable"; tr.addEventListener("click", () => onClick(r)); }
    for (const c of cols) {
      const td = tr.insertCell();
      if (c.cls) td.className = c.cls;
      const v = c.get(r);
      if (v instanceof Node) td.appendChild(v); else td.textContent = v ?? "";
    }
  }
  container.appendChild(t);
}

function lvl(level) {
  return text("span", level, "lvl " + level);
}

function fmtTs(ms) {
  return fmtDateTime(ms, true);
}

function fmtDuration(sec) {
  if (sec < 90) return Math.round(sec) + "s";
  if (sec < 5400) return Math.round(sec / 60) + " min";
  if (sec < 172800) return (sec / 3600).toFixed(1) + " h";
  return (sec / 86400).toFixed(1) + " d";
}

function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

// ---------------------------------------------------------------- status bar

function snap(name) {
  const s = state.status?.snapshots?.[name];
  return s && s.value && !s.value._error ? s.value : null;
}

function slotTime(slot) {
  const t = snap("time");
  if (!t) return null;
  return t.genesis_time_unix_ms + slot * t.slot_duration_ms;
}

function renderPills() {
  const st = state.status;
  const pills = $("#pills");
  pills.replaceChildren();
  const add = (label, value, color) => {
    const p = text("span", null, "pill");
    if (color) { const d = text("span", null, "dot"); d.style.background = color; p.appendChild(d); }
    p.appendChild(document.createTextNode(label + " "));
    p.appendChild(text("strong", value));
    pills.appendChild(p);
  };
  const ci = snap("cryptarchia");
  const h = st.health;
  if (ci) {
    const info = ci.cryptarchia_info;
    const online = String(info.state).toLowerCase() === "online";
    add("phase", ci.phase, ci.phase === "Following" ? css("--good") : css("--warning"));
    add("state", info.state, online ? css("--good") : css("--warning"));
    add("tip height", fmtInt(info.height));
    add("tip slot", fmtInt(info.slot));
    add("LIB slot", fmtInt(info.lib_slot));
    const t = snap("time");
    if (t) add("behind", fmtInt(t.current_slot - info.slot) + " slots");
  } else {
    add("node API", "unreachable", css("--critical"));
  }
  const net = snap("network");
  if (net) add("peers", fmtNum(net.n_peers));
  add("stream", h.stream_connected ? "live" : "down", h.stream_connected ? css("--good") : css("--critical"));
  $("#updated").textContent = "updated " + fmtClock(Date.now());
}

// ---------------------------------------------------------------- overview

function stat(container, label, value, hint) {
  const d = text("div", null, "stat");
  d.appendChild(text("div", label, "label"));
  d.appendChild(text("div", value, "value"));
  if (hint) { const h = text("div", hint, "hint"); h.title = hint; d.appendChild(h); }
  container.appendChild(d);
}

async function renderOverview() {
  const st = state.status;
  const stats = $("#stats");
  stats.replaceChildren();
  const ci = snap("cryptarchia");
  if (ci) {
    const i = ci.cryptarchia_info;
    stat(stats, "Height", fmtInt(i.height), "tip " + short(i.tip));
    stat(stats, "Tip slot", fmtInt(i.slot), slotTime(i.slot) ? fmtDateTime(slotTime(i.slot)) : "");
    stat(stats, "LIB slot", fmtInt(i.lib_slot), "lib " + short(i.lib) + " · " + fmtInt(i.slot - i.lib_slot) + " slots behind tip");
  }
  const t = snap("time");
  if (t && ci) {
    const i = ci.cryptarchia_info;
    const pct = Math.min(100, (100 * i.slot) / Math.max(1, t.current_slot));
    let hint = fmtInt(t.current_slot - i.slot) + " slots behind";
    try {
      const sr = await api(`/api/series?since=${Date.now() - 180e3}&names=cryptarchia.cryptarchia_info.slot`);
      const pts = sr["cryptarchia.cryptarchia_info.slot"] || [];
      if (pts.length > 2 && t.current_slot - i.slot > 60) {
        const [t0, s0] = pts[0], [t1, s1] = pts[pts.length - 1];
        const rate = (s1 - s0) / ((t1 - t0) / 1000) - 1000 / t.slot_duration_ms; // net catch-up slots/s
        if (rate > 0) hint += " · ETA " + fmtDuration((t.current_slot - i.slot) / rate);
      }
    } catch (e) { /* no samples yet */ }
    stat(stats, "Sync progress", pct >= 99.995 ? "synced" : pct.toFixed(2) + "%", hint);
  }
  if (t) stat(stats, "Wall-clock slot", fmtInt(t.current_slot), t.slot_duration_ms / 1000 + "s slots");
  if (t) {
    const into = t.current_slot % t.slots_per_epoch;
    const left = (t.slots_per_epoch - into) * t.slot_duration_ms / 1000;
    stat(stats, "Epoch", fmtInt(t.current_epoch), `${((100 * into) / t.slots_per_epoch).toFixed(1)}% · next in ${fmtDuration(left)}`);
  }
  const net = snap("network");
  if (net) stat(stats, "Peers", fmtNum(net.n_peers), net.n_connections + " connections · " + net.n_pending_connections + " pending");
  stat(stats, "Blocks known", fmtInt(st.blocks.n || 0), fmtNum(st.non_canonical_known) + " off the canonical chain");
  stat(stats, "Reorgs seen", fmtNum(st.reorgs.n || 0), st.reorgs.d ? "deepest " + st.reorgs.d + " blocks" : "since dashboard start");
  const ver = snap("version");
  if (ver) stat(stats, "Version", typeof ver === "string" ? ver : ver.version || JSON.stringify(ver).slice(0, 24));

  const s = since();
  const series = await api(`/api/series?since=${s}&names=cryptarchia.cryptarchia_info.height,cryptarchia.slots_behind,network.n_peers,network.n_connections,cryptarchia.tip_minus_lib_slots`);
  lineChart($("#ov-height"), [{ name: "height", points: series["cryptarchia.cryptarchia_info.height"], color: css("--series-1") }], { zero: false });
  lineChart($("#ov-behind"), [{ name: "slots behind", points: series["cryptarchia.slots_behind"], color: css("--series-2") }]);
  lineChart($("#ov-libdepth"), [{ name: "tip slot − LIB slot", points: series["cryptarchia.tip_minus_lib_slots"], color: css("--series-7") }]);
  lineChart($("#ov-peers"), [
    { name: "peers", points: series["network.n_peers"], color: css("--series-1"), step: true },
    { name: "connections", points: series["network.n_connections"], color: css("--series-3"), step: true },
  ]);

  const ls = await api(`/api/logsummary?since=${s}`);
  renderLevelBars($("#ov-levels"), ls.stats, s);

  const tree = await api("/api/tree?window=25");
  const F = Object.fromEntries(tree.fields.map((f, i) => [f, i]));
  const recent = tree.nodes.slice().sort((a, b) => (b[F.height] ?? 0) - (a[F.height] ?? 0) || b[F.slot] - a[F.slot]).slice(0, 25);
  table($("#ov-blocks"), [
    { name: "height", get: (n) => fmtInt(n[F.height]), cls: "num" },
    { name: "slot", get: (n) => fmtInt(n[F.slot]), cls: "num" },
    { name: "slot time", get: (n) => (slotTime(n[F.slot]) ? fmtClock(slotTime(n[F.slot])) : "") },
    { name: "arrival", get: (n) => (n[F.t_ms] && slotTime(n[F.slot]) ? ((n[F.t_ms] - slotTime(n[F.slot])) / 1000).toFixed(2) + "s" + (n[F.time_src] === "stream" ? " ≈" : "") : ""), cls: "num" },
    { name: "txs", get: (n) => n[F.txs], cls: "num" },
    { name: "status", get: (n) => (n[F.id] === tree.tip ? "tip" : n[F.canonical] ? "canonical" : "fork") + (state.myBlocks?.has(n[F.id]) ? " ★" : "") },
    { name: "id", get: (n) => short(n[F.id], 12), cls: "mono nowrap" },
  ], recent, (n) => selectBlock(n[F.id]));

  const warns = await api(`/api/events?level=WARN,ERROR&limit=200&since=${s}`);
  table($("#ov-warn"), [
    { name: "time", get: (r) => fmtDateTime(r.ts) },
    { name: "level", get: (r) => lvl(r.level) },
    { name: "target", get: (r) => r.target },
    { name: "message", get: (r) => r.msg, cls: "msg" },
  ], warns);

  const h = st.health;
  const kv = $("#ov-health");
  kv.replaceChildren();
  const add = (k, v) => { kv.appendChild(text("div", k)); kv.appendChild(text("div", v)); };
  add("Node API", st.api + (h.api_ok ? " · ok" : " · " + (h.api_error || "unreachable")));
  add("Block stream", (h.stream_connected ? "connected" : "disconnected") + " · last block " + timeAgo(h.stream_last_event_ms) + (h.stream_error ? " · " + h.stream_error : ""));
  add("Backfill", h.backfill || "–");
  add("Logs dir", st.logs_dir);
  add("Log files parsed", st.log_files.length + " files · " + fmtNum(st.events_total) + " matched events · scanned " + timeAgo(h.logs_last_scan_ms) + (h.logs_error ? " · " + h.logs_error : ""));
  add("OpenMetrics", h.metrics || "–");
  add("Data dir", st.data_dir);
}

function renderLevelBars(container, stats, s) {
  const levels = [["ERROR", css("--critical")], ["WARN", css("--warning")], ["INFO", css("--series-1")], ["DEBUG", css("--muted")], ["TRACE", css("--grid")]];
  if (!stats.length) return stackedBars(container, [], []);
  const xmax = Date.now();
  const xmin = Math.max(s || 0, stats[0][0] - 60e3);
  const b = pickBucket(xmax - xmin);
  const buckets = bucketRange(xmin, xmax, b);
  const stacks = levels.map(([name, color]) => ({ name, color, values: new Map() }));
  for (const [minute, level, , n] of stats) {
    const st = stacks.find((x) => x.name === level);
    if (!st) continue;
    const k = Math.floor(minute / b) * b;
    st.values.set(k, (st.values.get(k) || 0) + n);
  }
  stackedBars(container, buckets, stacks.filter((x) => x.values.size), { bucketMs: b });
}

// ---------------------------------------------------------------- block tree

const BH = 16, GY = 30, PADX = 40;
const STRIP_H = 15, STRIP_GAP = 3, STRIP_ROWS = ["phase", "mode", "epoch"];
const STRIPS_BOTTOM = 6 + STRIP_ROWS.length * (STRIP_H + STRIP_GAP);
const PADY = STRIPS_BOTTOM + 34;
const PHASE_COLORS = { "Genesis wait": "--muted", IBD: "--series-7", PBP: "--series-5", Following: "--series-3" };
const MODE_COLORS = { Bootstrapping: "--series-4", Online: "--series-6" };
let GX = 26, BW = 16;
function setZoom(gx) {
  GX = Math.max(4, Math.min(40, gx));
  BW = Math.max(3, Math.min(16, GX - 8));
}

async function loadTree() {
  const q = new URLSearchParams({ window: state.tree.window });
  if (state.tree.toHeight != null) q.set("to_height", state.tree.toHeight);
  state.tree.data = await api("/api/tree?" + q);
  renderTree();
}

function layoutTree(d) {
  const F = Object.fromEntries(d.fields.map((f, i) => [f, i]));
  const nodes = d.nodes.filter((n) => n[F.height] != null).map((n) => ({
    id: n[F.id], parent: n[F.parent], slot: n[F.slot], height: n[F.height], canonical: !!n[F.canonical],
    seen: n[F.t_ms], tsrc: n[F.time_src], txs: n[F.txs], uncles: n[F.uncles], source: n[F.source],
    phase: n[F.phase], mode: n[F.mode], inferred: !!n[F.inferred],
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of nodes) {
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent).push(n);
  }
  // subtree depth for ordering forks (longest first keeps lanes compact)
  const depth = new Map();
  const dfsDepth = (n) => {
    if (depth.has(n.id)) return depth.get(n.id);
    let m = 0;
    for (const k of kids.get(n.id) || []) if (!k.canonical) m = Math.max(m, 1 + dfsDepth(k));
    depth.set(n.id, m);
    return m;
  };
  const laneEnd = [Infinity]; // lane 0 reserved for canonical
  const findLane = (h) => {
    for (let i = 1; i < laneEnd.length; i++) if (laneEnd[i] < h - 1) return i;
    laneEnd.push(-Infinity);
    return laneEnd.length - 1;
  };
  for (const n of nodes) if (n.canonical) n.lane = 0;
  const place = (n, lane) => {
    n.lane = lane;
    laneEnd[lane] = Math.max(laneEnd[lane], n.height);
    const ks = (kids.get(n.id) || []).filter((k) => !k.canonical).sort((a, b) => dfsDepth(b) - dfsDepth(a));
    ks.forEach((k, i) => place(k, i === 0 ? lane : findLane(k.height)));
  };
  const roots = nodes.filter((n) => !n.canonical && !(byId.get(n.parent) && !byId.get(n.parent).canonical))
    .sort((a, b) => a.height - b.height);
  for (const r of roots) place(r, findLane(r.height));
  return { nodes, byId, lanes: laneEnd.length };
}

function renderTree() {
  const d = state.tree.data;
  setZoom(state.tree.zoom ?? (state.tree.window <= 300 ? 26 : state.tree.window <= 1000 ? 12 : 6));
  const svg = $("#tree-svg");
  svg.replaceChildren();
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs, parent = svg) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };
  const { nodes, byId, lanes } = layoutTree(d);
  if (!nodes.length) {
    svg.setAttribute("width", 400); svg.setAttribute("height", 120);
    mk("text", { x: 20, y: 60, class: "axis" }).textContent = "No blocks with a known height yet — waiting for the node API.";
    $("#tree-info").textContent = "";
    return;
  }
  let hmin = Infinity, hmax = -Infinity;
  for (const n of nodes) { hmin = Math.min(hmin, n.height); hmax = Math.max(hmax, n.height); }
  const W = PADX * 2 + (hmax - hmin) * GX + BW, H = PADY * 2 + (lanes - 1) * GY + BH + 10;
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  const X = (n) => PADX + (n.height - hmin) * GX;
  const Y = (n) => PADY + n.lane * GY;

  // immutable zone up to LIB
  if (d.lib_height != null && d.lib_height >= hmin) {
    const x = PADX + (Math.min(d.lib_height, hmax) - hmin) * GX + BW + (GX - BW) / 2;
    mk("rect", { x: 0, y: STRIPS_BOTTOM, width: x, height: H - STRIPS_BOTTOM, class: "immutable-zone" });
    if (d.lib_height <= hmax) {
      mk("line", { x1: x, x2: x, y1: STRIPS_BOTTOM, y2: H - 6, class: "lib-line" });
      mk("text", { x: x - 4, y: STRIPS_BOTTOM + 12, class: "lib-label", "text-anchor": "end" }).textContent = "LIB · height " + d.lib_height;
    }
  }
  drawStrips(mk, nodes, X, H, d);
  // height axis
  const every = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((e) => e * GX >= 60) || 1000;
  for (let h = Math.ceil(hmin / every) * every; h <= hmax; h += every) {
    mk("text", { x: PADX + (h - hmin) * GX + BW / 2, y: H - 8, class: "axis", "text-anchor": "middle" }).textContent = h;
  }
  // edges
  for (const n of nodes) {
    const p = byId.get(n.parent);
    if (p) {
      const x1 = X(p) + BW, y1 = Y(p) + BH / 2, x2 = X(n), y2 = Y(n) + BH / 2;
      const dpath = y1 === y2 ? `M${x1},${y1}L${x2},${y2}` : `M${x1},${y1}C${x1 + 10},${y1} ${x2 - 14},${y2} ${x2},${y2}`;
      mk("path", { d: dpath, class: "edge" + (n.canonical ? " canon" : "") });
    } else if (n.height > hmin) {
      mk("path", { d: `M${X(n) - 10},${Y(n) + BH / 2}L${X(n)},${Y(n) + BH / 2}`, class: "edge orphan" });
    }
  }
  // blocks
  const mine = state.myBlocks || new Set();
  for (const n of nodes) {
    const immutable = n.canonical && d.lib_height != null && n.height <= d.lib_height;
    const fill = !n.canonical ? css("--series-2") : immutable ? css("--immutable") : css("--series-1");
    const g = mk("g", { class: "blk" + (state.tree.selected === n.id ? " selected" : ""), tabindex: 0 });
    mk("rect", { x: X(n), y: Y(n), width: BW, height: BH, rx: 4, fill }, g);
    if (mine.has(n.id) && BW >= 10) mk("text", { x: X(n) + BW / 2, y: Y(n) + BH - 4, class: "mine", "text-anchor": "middle" }, g).textContent = "★";
    if (n.id === d.tip) mk("text", { x: X(n) + BW / 2, y: Y(n) - 6, class: "tip-label", "text-anchor": "middle" }).textContent = "tip";
    g.addEventListener("click", () => selectBlock(n.id));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter") selectBlock(n.id); });
    g.addEventListener("pointermove", (e) => {
      const tt = document.getElementById("viz-tooltip") || (() => { const t = document.createElement("div"); t.id = "viz-tooltip"; t.className = "viz-tooltip"; document.body.appendChild(t); return t; })();
      tt.replaceChildren(text("div", short(n.id, 12), "tt-title"));
      const rows = [["height", n.height], ["slot", n.slot], ["txs", n.txs], [n.canonical ? (immutable ? "immutable" : "canonical") : "fork", ""]];
      if (n.seen) rows.push([fmtClock(n.seen), n.tsrc === "stream" ? "seen by dashboard" : n.tsrc + " (node log)"]);
      for (const [k, v] of rows) { const r = text("div", null, "tt-row"); r.appendChild(text("strong", String(v))); r.appendChild(text("span", k, "tt-label")); tt.appendChild(r); }
      tt.style.display = "block"; tt.style.left = e.clientX + 14 + "px"; tt.style.top = e.clientY + 14 + "px";
    });
    g.addEventListener("pointerleave", () => { const tt = document.getElementById("viz-tooltip"); if (tt) tt.style.display = "none"; });
  }
  renderPhaseStrip(d.intervals || {});
  const forks = nodes.filter((n) => !n.canonical).length;
  $("#tree-info").textContent = `heights ${hmin}–${hmax} · ${nodes.length} blocks · ${forks} off canonical · known heights ${d.min_height ?? "?"}–${d.max_height ?? "?"}`;

  table($("#tree-reorgs"), [
    { name: "time", get: (r) => fmtDateTime(r.ts) },
    { name: "depth (abandoned blocks)", get: (r) => r.depth, cls: "num" },
    { name: "old tip", get: (r) => short(r.old, 12), cls: "msg" },
    { name: "new tip", get: (r) => short(r.new, 12), cls: "msg" },
    { name: "slot", get: (r) => r.slot, cls: "num" },
  ], d.reorgs, (r) => selectBlock(r.new));
}

function tipEl() {
  let t = document.getElementById("viz-tooltip");
  if (!t) { t = document.createElement("div"); t.id = "viz-tooltip"; t.className = "viz-tooltip"; document.body.appendChild(t); }
  return t;
}

// Bands above the blocks: chain phase and mode the node was in when it
// processed each canonical block, and the epoch of the block's slot.
function drawStrips(mk, nodes, X, H, d) {
  const t = snap("time");
  const canon = nodes.filter((n) => n.lane === 0).sort((a, b) => a.height - b.height);
  const pad = (GX - BW) / 2;
  const rows = {
    phase: { val: (n) => n.phase, color: (v) => PHASE_COLORS[v] || "--muted", label: (v) => v },
    mode: { val: (n) => n.mode, color: (v) => MODE_COLORS[v] || "--muted", label: (v) => v },
    epoch: {
      val: (n) => (t ? Math.floor(n.slot / t.slots_per_epoch) : null),
      color: (v) => (v % 2 ? "--series-1" : "--muted"), label: (v) => "epoch " + v,
    },
  };
  STRIP_ROWS.forEach((key, ri) => {
    const row = rows[key];
    const y = 6 + ri * (STRIP_H + STRIP_GAP);
    const segs = [];
    for (const n of canon) {
      const v = row.val(n);
      const last = segs[segs.length - 1];
      if (last && last.v === v && last.inferred === (key !== "epoch" && n.inferred) && n.height === last.to + 1) last.to = n.height, last.lastNode = n;
      else segs.push({ v, from: n.height, to: n.height, firstNode: n, lastNode: n, inferred: key !== "epoch" && n.inferred });
    }
    for (const sg of segs) {
      if (sg.v == null) continue;
      const x0 = X(sg.firstNode) - pad, x1 = X(sg.lastNode) + BW + pad;
      const g = mk("g", { class: "strip" });
      mk("rect", { x: x0, y, width: Math.max(1, x1 - x0), height: STRIP_H, rx: 3, fill: css(row.color(sg.v)),
        "fill-opacity": sg.inferred ? 0.14 : key === "epoch" ? 0.22 : 0.38, class: sg.inferred ? "strip-inferred" : "" }, g);
      const label = row.label(sg.v) + (sg.inferred ? " (inferred)" : "");
      const need = label.length * 6.2 + 8;
      if (x1 - x0 > need) {
        // Long bands repeat their label so it is visible wherever you scroll.
        const every = 420;
        const n = Math.max(1, Math.floor((x1 - x0) / every));
        for (let i = 0; i < n; i++) {
          const cx = n === 1 ? (x0 + x1) / 2 : x0 + every * (i + 0.5);
          mk("text", { x: cx, y: y + 11, class: "strip-label", "text-anchor": "middle" }, g).textContent = label;
        }
      }
      g.addEventListener("pointermove", (e) => {
        const tt = tipEl();
        tt.replaceChildren(text("div", key, "tt-title"));
        const add = (v, l) => { const r = text("div", null, "tt-row"); r.appendChild(text("strong", String(v))); r.appendChild(text("span", l, "tt-label")); tt.appendChild(r); };
        add(row.label(sg.v), sg.inferred ? "inferred: processed before the dashboard saw blocks live" : "");
        add(`${sg.from}–${sg.to}`, "heights in view");
        tt.style.display = "block"; tt.style.left = e.clientX + 14 + "px"; tt.style.top = e.clientY + 14 + "px";
      });
      g.addEventListener("pointerleave", () => { const tt = document.getElementById("viz-tooltip"); if (tt) tt.style.display = "none"; });
    }
    if (key === "epoch") {
      for (let i = 1; i < segs.length; i++) {
        const x = X(segs[i].firstNode) - pad;
        mk("line", { x1: x, x2: x, y1: y + STRIP_H, y2: H - 20, class: "epoch-line" });
      }
    }
  });
}

// Time-based strip of every phase/mode interval, including ones without
// blocks (waiting for genesis, node down).
function renderPhaseStrip(iv) {
  const box = $("#phase-strip");
  box.replaceChildren();
  const all = [...(iv.phase || []), ...(iv.mode || [])];
  if (!all.length) { box.appendChild(text("div", "No phase information yet (needs node logs or API polls).", "viz-empty")); return; }
  const t0 = Math.min(...all.map((x) => x[0])), t1 = Math.max(Date.now(), ...all.map((x) => x[1]));
  const w = Math.max(box.clientWidth || 800, 300), lw = 70, h = 3 * (STRIP_H + 6) + 26;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("class", "viz");
  box.appendChild(svg);
  const mk = (tag, attrs, parent = svg) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent.appendChild(e); return e; };
  const X = (ts) => lw + ((ts - t0) / Math.max(1, t1 - t0)) * (w - lw - 10);
  const dur = (ms) => fmtDuration(ms / 1000);
  const tinfo = snap("time");
  const epochs = [];
  if (tinfo) {
    const len = tinfo.slots_per_epoch * tinfo.slot_duration_ms;
    for (let e = Math.max(0, Math.floor((t0 - tinfo.genesis_time_unix_ms) / len)); ; e++) {
      const a = tinfo.genesis_time_unix_ms + e * len;
      if (a > t1) break;
      epochs.push([Math.max(a, t0), Math.min(a + len, t1), "epoch " + e]);
    }
  }
  const epochColors = new Proxy({}, { get: (_, v) => (parseInt(String(v).slice(6)) % 2 ? "--series-1" : "--muted") });
  [["phase", iv.phase || [], PHASE_COLORS], ["mode", iv.mode || [], MODE_COLORS], ["epoch", epochs, epochColors]].forEach(([name, lst, colors], ri) => {
    const y = 4 + ri * (STRIP_H + 6);
    mk("text", { x: 0, y: y + 11, class: "tick" }).textContent = name;
    for (const [a, b, v] of lst) {
      const g = mk("g", { class: "strip" });
      const x0 = X(a), x1 = Math.max(X(b), x0 + 3);
      mk("rect", { x: x0, y, width: x1 - x0, height: STRIP_H, rx: 3, fill: css(colors[v] || "--muted"), "fill-opacity": 0.45 }, g);
      if (x1 - x0 > v.length * 6.2 + 8) mk("text", { x: (x0 + x1) / 2, y: y + 11, class: "strip-label", "text-anchor": "middle" }, g).textContent = v;
      g.addEventListener("pointermove", (e) => {
        const tt = tipEl();
        tt.replaceChildren(text("div", name, "tt-title"));
        for (const [val, lab] of [[v, ""], [dur(b - a), "duration"], [fmtDateTime(a), "from"], [fmtDateTime(b), "to"]]) {
          const r = text("div", null, "tt-row"); r.appendChild(text("strong", val)); r.appendChild(text("span", lab, "tt-label")); tt.appendChild(r);
        }
        tt.style.display = "block"; tt.style.left = e.clientX + 14 + "px"; tt.style.top = e.clientY + 14 + "px";
      });
      g.addEventListener("pointerleave", () => { const tt = document.getElementById("viz-tooltip"); if (tt) tt.style.display = "none"; });
    }
  });
  const yAxis = 3 * (STRIP_H + 6) + 18;
  for (let i = 0; i <= 5; i++) {
    const ts = t0 + ((t1 - t0) * i) / 5;
    mk("text", { x: X(ts), y: yAxis, class: "tick", "text-anchor": i === 0 ? "start" : i === 5 ? "end" : "middle" }).textContent = fmtTime(ts, t1 - t0) + (i === 5 ? " " + TZ : "");
  }
  const lg = text("div", null, "viz-legend");
  for (const [v, c] of Object.entries({ ...PHASE_COLORS, ...MODE_COLORS })) {
    const it = text("span", null, "lg-item"); const k = text("span", null, "lg-rect"); k.style.background = css(c); k.style.opacity = 0.7;
    it.append(k, v); lg.appendChild(it);
  }
  box.appendChild(lg);
}

function scrollTreeToEnd() {
  const s = $("#tree-scroll");
  s.scrollLeft = s.scrollWidth;
}

function kvBlock(container, pairs) {
  const kv = text("div", null, "kv");
  for (const [k, v] of pairs) {
    kv.appendChild(text("div", k));
    const d = document.createElement("div");
    if (v instanceof Node) d.appendChild(v); else d.textContent = v ?? "–";
    kv.appendChild(d);
  }
  container.appendChild(kv);
}

function blockLink(id, label) {
  const a = text("a", label || short(id, 12));
  a.addEventListener("click", () => selectBlock(id));
  a.className = "mono";
  return a;
}

async function selectBlock(id) {
  state.tree.selected = id;
  if (location.hash !== "#block/" + id) history.replaceState(null, "", "#block/" + id);
  document.querySelectorAll("#tree-svg .blk.selected").forEach((e) => e.classList.remove("selected"));
  if (state.tab !== "tree") switchTab("tree");
  const panel = $("#block-panel");
  panel.replaceChildren(text("div", "Loading…", "muted"));
  if (!state.status) state.status = await api("/api/status");
  const r = await api("/api/block/" + id);
  panel.replaceChildren();
  if (r.error) { panel.appendChild(text("div", r.error, "muted")); return; }
  const m = r.meta, b = r.block || {}, h = b.header || {};
  const head = text("div");
  const status = m.is_tip ? "tip" : m.canonical ? (state.tree.data?.lib_height != null && m.height <= state.tree.data.lib_height ? "immutable" : "canonical") : "fork";
  head.appendChild(text("span", status, "badge"));
  if (m.is_lib) head.appendChild(text("span", "LIB", "badge"));
  if (state.myBlocks?.has(id)) head.appendChild(text("span", "★ proposed by this node", "badge"));
  panel.appendChild(head);
  panel.appendChild(text("h4", "Block"));
  panel.appendChild(text("div", id, "id"));
  const st = slotTime(h.slot);
  kvBlock(panel, [
    ["height", m.height],
    ["slot", h.slot],
    ["slot time", st ? fmtDateTime(st) : null],
    ["parent", h.parent_block ? blockLink(h.parent_block) : null],
    ["children", r.children.length ? (() => { const s = document.createElement("span"); r.children.forEach((c, i) => { if (i) s.append(", "); s.append(blockLink(c.id)); }); return s; })() : "none"],
    ["received (node log)", m.received_ms ? fmtTs(m.received_ms) : "–"],
    ["applied (node log)", m.applied_ms ? fmtTs(m.applied_ms) : "–"],
    ["processing time", m.received_ms && m.applied_ms ? (m.applied_ms - m.received_ms) + " ms" : null],
    ["seen by dashboard", m.seen_ms ? fmtTs(m.seen_ms) + " (approx.)" : "no (" + (m.source || "?") + ")"],
    ["arrival delay", (() => {
      const t = m.applied_ms || m.received_ms || m.seen_ms;
      if (!t || !st) return null;
      const src = m.applied_ms ? "applied" : m.received_ms ? "received" : "seen by dashboard, approx.";
      return ((t - st) / 1000).toFixed(3) + " s after slot start (" + src + ")";
    })()],
    ["transactions", (b.transactions || []).length],
    ["uncle headers", (b.uncle_headers || []).length],
    ["body root", h.body_root ? text("span", h.body_root, "mono") : null],
    ["tip when seen", m.tip_at_seen ? blockLink(m.tip_at_seen) : null],
    ["LIB when seen", m.lib_at_seen ? blockLink(m.lib_at_seen) : null],
  ]);
  const sec = (title, obj, open) => {
    const det = document.createElement("details");
    if (open) det.open = true;
    det.appendChild(text("summary", title));
    det.appendChild(text("pre", JSON.stringify(obj, null, 2), "code"));
    panel.appendChild(det);
  };
  const ops = m.ops || {};
  if (Object.keys(ops).length) {
    const line = text("div", null, "op-badges");
    for (const [c, n] of Object.entries(ops).sort((a, b) => b[1] - a[1])) line.appendChild(text("span", `${opName(c)} × ${n}`, "badge"));
    panel.appendChild(line);
  }
  if ((b.transactions || []).length) {
    panel.appendChild(text("h4", `Transactions (${b.transactions.length})`));
    const wrap = text("div", null, "table-wrap short");
    table(wrap, [
      { name: "tx", get: (tx) => (tx.mantle_tx?.hash || "").slice(0, 10) + "…", cls: "mono nowrap" },
      { name: "ops", get: (tx) => (tx.mantle_tx?.ops || []).map((o) => opName(o.opcode)).join(", ") },
      { name: "out value", get: (tx) => fmtInt((tx.mantle_tx?.ops || []).flatMap((o) => o.payload?.outputs || []).reduce((a, o) => a + (o.value || 0), 0)), cls: "num" },
      { name: "proofs", get: (tx) => (tx.ops_proofs || []).map((p) => Object.keys(p || {})[0]).join(", ") },
    ], b.transactions, (tx) => {
      const det = panel.querySelector("details.tx-json");
      det.open = true;
      det.querySelector("pre").textContent = JSON.stringify(tx, null, 2);
      det.scrollIntoView({ block: "nearest" });
    });
    panel.appendChild(wrap);
    const det = document.createElement("details");
    det.className = "tx-json";
    det.appendChild(text("summary", "Selected transaction JSON (click a row)"));
    det.appendChild(text("pre", "", "code"));
    panel.appendChild(det);
  }
  if ((b.uncle_headers || []).length) sec(`Uncle headers (${b.uncle_headers.length})`, b.uncle_headers, false);
  if (h.proof_of_leadership) sec("Proof of leadership", h.proof_of_leadership, false);
  if (Array.isArray(r.node_events) && r.node_events.length) {
    panel.appendChild(text("h4", `Ledger events (${r.node_events.length})`));
    const wrap = text("div", null, "table-wrap short");
    const evRows = r.node_events.map((e) => {
      const [scope, body] = Object.entries(e)[0] || ["?", {}];
      const [kind, payload] = Object.entries(body?.payload || {})[0] || [scope, body];
      const val = payload?.utxo?.note?.value ?? payload?.note?.value ?? payload?.value ?? payload?.amount;
      return { tx: body?.tx_hash || "", kind, val, raw: e };
    });
    table(wrap, [
      { name: "tx", get: (x) => x.tx.slice(0, 10) + (x.tx ? "…" : ""), cls: "mono nowrap" },
      { name: "event", get: (x) => x.kind },
      { name: "value", get: (x) => (x.val != null ? fmtInt(x.val) : ""), cls: "num" },
    ], evRows);
    panel.appendChild(wrap);
    sec("Ledger events JSON", r.node_events, false);
  } else if (r.node_events && !r.node_events._error) sec("Ledger events (node API)", r.node_events, false);
  if (r.log_mentions.length) {
    panel.appendChild(text("h4", `Log lines mentioning this block (${r.log_mentions.length})`));
    const wrap = text("div", null, "table-wrap short");
    table(wrap, [
      { name: "time", get: (x) => fmtClock(x.ts) },
      { name: "kind", get: (x) => x.kind },
      { name: "message", get: (x) => x.msg, cls: "msg" },
    ], r.log_mentions);
    panel.appendChild(wrap);
  }
  sec("Raw block JSON", b, false);
  // make sure the selected block is in the rendered window
  const inWindow = state.tree.data?.nodes.some((n) => n[0] === id);
  if (!inWindow && m.height != null) {
    state.tree.toHeight = m.height + Math.floor(state.tree.window / 2);
    await loadTree();
  } else {
    renderTree();
  }
  centerOn(id);
}

function centerOn(id) {
  const g = [...document.querySelectorAll("#tree-svg .blk")].find((e) => e.classList.contains("selected"));
  if (!g) return;
  const s = $("#tree-scroll");
  const r = g.getBBox();
  s.scrollLeft = r.x - s.clientWidth / 2;
  s.scrollTop = r.y - s.clientHeight / 2;
}

function initTreeControls() {
  document.querySelectorAll("#tree-window button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#tree-window button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.tree.window = +b.dataset.w;
    loadTree().then(() => state.tree.toHeight == null && scrollTreeToEnd());
  }));
  const page = (dir) => {
    const d = state.tree.data;
    const top = state.tree.toHeight ?? d?.max_height ?? 0;
    state.tree.toHeight = Math.max(state.tree.window, top + dir * Math.floor(state.tree.window * 0.8));
    if (d && state.tree.toHeight >= d.max_height) state.tree.toHeight = null;
    loadTree().then(() => dir > 0 ? scrollTreeToEnd() : ($("#tree-scroll").scrollLeft = 0));
  };
  $("#tree-older").addEventListener("click", () => page(-1));
  $("#tree-newer").addEventListener("click", () => page(1));
  const zoomBy = (f) => {
    const s = $("#tree-scroll");
    const center = (s.scrollLeft + s.clientWidth / 2 - PADX) / GX;
    state.tree.zoom = Math.round(Math.max(4, Math.min(40, GX * f)));
    renderTree();
    s.scrollLeft = center * GX + PADX - s.clientWidth / 2;
  };
  $("#tree-zoom-in").addEventListener("click", () => zoomBy(1.5));
  $("#tree-zoom-out").addEventListener("click", () => zoomBy(1 / 1.5));
  $("#tree-latest").addEventListener("click", () => { state.tree.toHeight = null; loadTree().then(scrollTreeToEnd); });
  $("#tree-search").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v)) return selectBlock(v);
    if (/^\d+$/.test(v)) {
      // height first, then slot
      state.tree.toHeight = +v + Math.floor(state.tree.window / 2);
      await loadTree();
      const F = state.tree.data.fields.indexOf("height");
      const S = state.tree.data.fields.indexOf("slot");
      const n = state.tree.data.nodes.find((x) => x[F] === +v && x[4]) || state.tree.data.nodes.find((x) => x[S] === +v);
      if (n) selectBlock(n[0]);
    }
  });
  // drag to pan
  const s = $("#tree-scroll");
  let drag = null;
  s.addEventListener("pointerdown", (e) => { if (e.target.closest(".blk")) return; drag = { x: e.clientX, y: e.clientY, l: s.scrollLeft, t: s.scrollTop }; s.classList.add("dragging"); });
  window.addEventListener("pointermove", (e) => { if (!drag) return; s.scrollLeft = drag.l - (e.clientX - drag.x); s.scrollTop = drag.t - (e.clientY - drag.y); });
  window.addEventListener("pointerup", () => { drag = null; s.classList.remove("dragging"); });

  const lg = $("#tree-legend");
  for (const [label, color] of [["canonical", "--series-1"], ["immutable (≤ LIB)", "--immutable"], ["fork / abandoned branch", "--series-2"]]) {
    const sp = text("span");
    const i = document.createElement("i"); i.style.background = css(color);
    sp.append(i, label);
    lg.appendChild(sp);
  }
  lg.appendChild(text("span", "★ proposed by this node · drag to pan · click a block for details"));
}

// ---------------------------------------------------------------- plot tabs

export const ctx = {
  api, since, css, lineChart, scatter, stackedBars, histogram, bucketize, bucketRange, pickBucket, fmtNum, fmtTime,
  fmtDateTime, fmtClock, TZ,
  slotTime, snap, selectBlock, table, text, OP_NAMES,
  get status() { return state.status; },
};

async function renderPlotTab(name) {
  const spec = PLOT_TABS[name];
  const grid = $("#plots-" + name);
  if (!grid.dataset.built) {
    grid.replaceChildren();
    for (const p of spec) {
      const card = text("div", null, "card");
      card.appendChild(text("h3", p.title));
      if (p.sub) card.appendChild(text("div", p.sub, "sub"));
      const c = text("div", null, "chart");
      card.appendChild(c);
      p.el = c;
      if (p.wide) card.style.gridColumn = "1 / -1";
      grid.appendChild(card);
    }
    grid.dataset.built = "1";
  }
  const cache = {};
  const fetchCached = (path) => (cache[path] ||= api(path));
  await Promise.all(spec.map(async (p) => {
    try {
      await p.render(p.el, { ...ctx, get: fetchCached });
    } catch (e) {
      p.el.replaceChildren(text("div", "Error: " + e.message, "viz-empty"));
      console.error(p.title, e);
    }
  }));
}

// ---------------------------------------------------------------- logs

async function renderLogs() {
  const s = since();
  const ls = await api(`/api/logsummary?since=${s}`);
  const cats = new Map();
  for (const [minute, , cat, n] of ls.stats) {
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push([minute, n]);
  }
  const xmax = Date.now();
  const xmin = Math.max(s || 0, (ls.stats[0] || [xmax])[0] - 60e3);
  const b = pickBucket(xmax - xmin);
  const ranked = [...cats.entries()].map(([c, pts]) => [c, pts.reduce((a, p) => a + p[1], 0), pts]).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 7);
  const other = ranked.slice(7);
  const colorOf = (i) => css(["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7"][i]);
  const stacks = top.map(([c, , pts], i) => {
    const m = new Map();
    for (const [t, n] of pts) { const k = Math.floor(t / b) * b; m.set(k, (m.get(k) || 0) + n); }
    return { name: c, color: colorOf(i), values: m };
  });
  if (other.length) {
    const m = new Map();
    for (const [, , pts] of other) for (const [t, n] of pts) { const k = Math.floor(t / b) * b; m.set(k, (m.get(k) || 0) + n); }
    stacks.push({ name: "other", color: css("--muted"), values: m });
  }
  stackedBars($("#lg-cats"), ls.stats.length ? bucketRange(xmin, xmax, b) : [], stacks, { bucketMs: b });

  table($("#lg-kinds"), [
    { name: "category", get: (r) => r.category },
    { name: "kind", get: (r) => r.kind },
    { name: "count", get: (r) => fmtNum(r.n), cls: "num" },
    { name: "last", get: (r) => timeAgo(r.last) },
  ], ls.kinds, (r) => { $("#ev-kind").value = r.kind; searchEvents(); });

  const sel = $("#ev-kind");
  const cur = sel.value;
  sel.replaceChildren(new Option("all kinds", ""));
  for (const k of [...new Set(ls.kinds.map((x) => x.kind))].sort()) sel.appendChild(new Option(k, k));
  sel.value = cur;

  table($("#lg-templates"), [
    { name: "count", get: (r) => fmtNum(r.n), cls: "num" },
    { name: "level", get: (r) => lvl(r.level) },
    { name: "target", get: (r) => r.target },
    { name: "message template", get: (r) => r.template, cls: "msg" },
    { name: "last", get: (r) => timeAgo(r.last_ts) },
  ], ls.templates, (r) => { $("#ev-grep").value = r.example.slice(0, 40); searchEvents(); });
  await searchEvents();
  await tail();
}

async function searchEvents() {
  const q = new URLSearchParams({ since: since(), limit: 500 });
  if ($("#ev-grep").value) q.set("grep", $("#ev-grep").value);
  if ($("#ev-level").value) q.set("level", $("#ev-level").value);
  if ($("#ev-kind").value) q.set("kinds", $("#ev-kind").value);
  const rows = await api("/api/events?" + q);
  table($("#ev-table"), [
    { name: "time", get: (r) => fmtDateTime(r.ts) },
    { name: "level", get: (r) => lvl(r.level) },
    { name: "kind", get: (r) => r.kind },
    { name: "target", get: (r) => r.target },
    { name: "message", get: (r) => r.msg, cls: "msg" },
  ], rows, (r) => { const m = r.msg.match(/[0-9a-f]{64}/); if (m) selectBlock(m[0]); });
}

async function tail() {
  const q = new URLSearchParams({ n: 400 });
  if ($("#tail-grep").value) q.set("grep", $("#tail-grep").value);
  const r = await api("/api/logtail?" + q);
  $("#tail-file").textContent = r.file ? "· " + r.file : "· no log file found";
  const pre = $("#tail");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = r.lines.join("\n");
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ---------------------------------------------------------------- config

async function renderConfig() {
  const q = state.configFile ? "?file=" + encodeURIComponent(state.configFile) : "";
  const r = await api("/api/config" + q);
  const list = $("#cfg-files");
  list.replaceChildren();
  for (const f of r.files) {
    const d = text("div", null, "f" + (f.path === state.configFile ? " sel" : "") + (f.text ? "" : " nontext"));
    d.appendChild(text("span", f.path, "mono"));
    d.appendChild(text("span", fmtNum(f.size) + "B", "muted"));
    d.title = fmtDateTime(f.mtime_ms);
    if (f.text) d.addEventListener("click", () => { state.configFile = f.path; renderConfig(); });
    list.appendChild(d);
  }
  if (!state.configFile) {
    const first = r.files.find((f) => f.path === "user_config.yaml") || r.files.find((f) => f.text);
    if (first) { state.configFile = first.path; return renderConfig(); }
  }
  if (r.content) {
    $("#cfg-title").textContent = r.content.path;
    $("#cfg-note").textContent = r.content.redacted ? "Values of secret-looking keys are hidden. Start the dashboard with --show-secrets to see them." : "";
    state.configText = r.content.text;
    renderConfigText();
    const nav = $("#cfg-sections");
    nav.replaceChildren();
    r.content.text.split("\n").forEach((line, i) => {
      const m = line.match(/^([\w.-]+):/);
      if (!m) return;
      const b = text("button", m[1], "btn");
      b.addEventListener("click", () => {
        $("#cfg-filter").value = "";
        renderConfigText();
        const pre = $("#cfg-content");
        pre.scrollTop = (i * pre.scrollHeight) / pre.textContent.split("\n").length;
      });
      nav.appendChild(b);
    });
  }
}

// Filter keeps matching lines plus their parent keys, so matches stay in context.
function renderConfigText() {
  const q = $("#cfg-filter").value.trim().toLowerCase();
  const lines = (state.configText || "").split("\n");
  if (!q) { $("#cfg-content").textContent = state.configText || ""; return; }
  const out = [];
  const parents = [];
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
    if (line.toLowerCase().includes(q)) {
      for (const p of parents) if (!p.shown) { out.push(p.line); p.shown = true; }
      out.push(line);
    }
    if (/:\s*$/.test(line)) parents.push({ indent, line, shown: false });
  }
  $("#cfg-content").textContent = out.length ? out.join("\n") : "(no match)";
}

// ---------------------------------------------------------------- shell

function switchTab(name) {
  state.tab = name;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  $("#filters").style.display = ["tree", "config"].includes(name) ? "none" : "";
  refresh(true);
}

let refreshing = false;
async function refresh(first) {
  if (refreshing) return;
  refreshing = true;
  try {
    state.status = await api("/api/status");
    renderPills();
    if (!state.myBlocks || first) {
      const mine = await api("/api/events?kinds=block_proposed&limit=50000&since=0");
      state.myBlocks = new Set(mine.map((e) => e.fields.block_id || (e.msg.match(/[0-9a-f]{64}/) || [])[0]).filter(Boolean));
    }
    const t = state.tab;
    if (t === "overview") await renderOverview();
    else if (t === "tree") {
      const s = $("#tree-scroll");
      const atEnd = s.scrollLeft + s.clientWidth >= s.scrollWidth - 40;
      if (first || state.tree.toHeight == null) {
        await loadTree();
        if (atEnd || first) { if (state.tree.selected && first) centerOn(state.tree.selected); else scrollTreeToEnd(); }
      }
    } else if (PLOT_TABS[t]) await renderPlotTab(t);
    else if (t === "logs") { if (first) await renderLogs(); else await tail(); }
    else if (t === "config" && first) await renderConfig();
  } catch (e) {
    console.error(e);
    $("#updated").textContent = "dashboard error: " + e.message;
  } finally {
    refreshing = false;
  }
}

function init() {
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => { history.replaceState(null, "", "#" + b.dataset.tab); switchTab(b.dataset.tab); }));
  document.querySelectorAll("#range button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#range button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.range = +b.dataset.range;
    refresh(true);
  }));
  $("#ev-go").addEventListener("click", searchEvents);
  $("#ev-grep").addEventListener("keydown", (e) => e.key === "Enter" && searchEvents());
  $("#tail-go").addEventListener("click", tail);
  $("#cfg-filter").addEventListener("input", renderConfigText);
  $("#tail-grep").addEventListener("keydown", (e) => e.key === "Enter" && tail());
  initTreeControls();
  window.addEventListener("resize", () => refresh(true));
  setInterval(() => { if ($("#autorefresh").checked) refresh(false); }, 10000);
  const route = () => {
    const h = location.hash.slice(1);
    if (h.startsWith("block/")) {
      const id = h.slice(6);
      if (id !== state.tree.selected) { switchTab("tree"); selectBlock(id); }
    } else if (h && document.querySelector(`#tabs button[data-tab="${h}"]`)) switchTab(h);
    else switchTab("overview");
  };
  route();
  window.addEventListener("hashchange", route);
}

init();
