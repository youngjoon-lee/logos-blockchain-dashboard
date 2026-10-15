// Minimal SVG charts: line/step, scatter, stacked bars over time, histogram.
// Every chart has a hover layer (crosshair for x-continuous, per-mark otherwise).

const SVGNS = "http://www.w3.org/2000/svg";

export const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7", "--series-8"];

export function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// Every displayed time is in the viewer's local timezone and says which one.
export const TZ = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date())
      .find((p) => p.type === "timeZoneName").value;
  } catch (e) {
    const off = -new Date().getTimezoneOffset();
    return "UTC" + (off >= 0 ? "+" : "−") + Math.floor(Math.abs(off) / 60) + (off % 60 ? ":" + String(Math.abs(off) % 60).padStart(2, "0") : "");
  }
})();

export function fmtDateTime(ms, withMs = false) {
  if (ms == null) return "–";
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return base + (withMs ? "." + p(d.getMilliseconds(), 3) : "") + " " + TZ;
}

export function fmtClock(ms) {
  if (ms == null) return "–";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${TZ}`;
}

export function fmtTime(ms, span) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  if (span > 2 * 86400e3) return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (span > 600e3) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtNum(v) {
  if (v == null || Number.isNaN(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "G";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return (v / 1e3).toFixed(1) + "k";
  if (Number.isInteger(v)) return String(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

function niceTicks(min, max, n = 5, integer = false) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  if (integer) step = Math.max(1, Math.round(step));
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(+t.toPrecision(12));
  return ticks;
}

function timeTicks(min, max, n = 6) {
  const steps = [1e3, 5e3, 15e3, 30e3, 60e3, 300e3, 900e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 7 * 86400e3];
  const step = steps.find((s) => (max - min) / s <= n) || steps[steps.length - 1];
  const off = new Date().getTimezoneOffset() * 60e3;
  const ticks = [];
  for (let t = Math.ceil((min - off) / step) * step + off; t <= max; t += step) ticks.push(t);
  return ticks;
}

function tooltip() {
  let t = document.getElementById("viz-tooltip");
  if (!t) {
    t = document.createElement("div");
    t.id = "viz-tooltip";
    t.className = "viz-tooltip";
    document.body.appendChild(t);
  }
  return t;
}

function showTip(evt, title, rows) {
  const t = tooltip();
  t.replaceChildren();
  const h = document.createElement("div");
  h.className = "tt-title";
  h.textContent = title;
  t.appendChild(h);
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "tt-row";
    if (r.color) {
      const k = document.createElement("span");
      k.className = "tt-key";
      k.style.background = r.color;
      row.appendChild(k);
    }
    const v = document.createElement("strong");
    v.textContent = r.value;
    row.appendChild(v);
    const l = document.createElement("span");
    l.className = "tt-label";
    l.textContent = r.label;
    row.appendChild(l);
    t.appendChild(row);
  }
  t.style.display = "block";
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = x + "px";
  t.style.top = y + "px";
}

function hideTip() {
  tooltip().style.display = "none";
}

function legend(container, series) {
  if (series.length < 2) return;
  const lg = document.createElement("div");
  lg.className = "viz-legend";
  series.forEach((s) => {
    const it = document.createElement("span");
    it.className = "lg-item";
    const k = document.createElement("span");
    k.className = s.kind === "bar" ? "lg-rect" : s.kind === "dot" ? "lg-dot" : "lg-line";
    k.style.background = s.color;
    it.appendChild(k);
    it.appendChild(document.createTextNode(s.name));
    lg.appendChild(it);
  });
  container.appendChild(lg);
}

function frame(container, opts) {
  container.replaceChildren();
  const w = Math.max(container.clientWidth || 600, 280);
  const h = opts.height || 220;
  const m = { l: opts.marginLeft || 52, r: 12, t: 10, b: opts.xTime === false ? 26 : 36 };
  const svg = el("svg", { width: w, height: h, class: "viz", viewBox: `0 0 ${w} ${h}` });
  container.appendChild(svg);
  return { svg, w, h, m, iw: w - m.l - m.r, ih: h - m.t - m.b };
}

function axes(f, xs, ys, xTime, yFmt = fmtNum, xFmt) {
  const { svg, m, iw, ih } = f;
  const g = el("g", {}, svg);
  for (const t of ys.ticks) {
    const y = m.t + ys.map(t);
    el("line", { x1: m.l, x2: m.l + iw, y1: y, y2: y, class: "grid" }, g);
    const tx = el("text", { x: m.l - 6, y: y + 4, class: "tick", "text-anchor": "end" }, g);
    tx.textContent = yFmt(t);
  }
  el("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, class: "baseline" }, g);
  const span = xs.max - xs.min;
  if (xTime && !xFmt) {
    const tz = el("text", { x: m.l + iw, y: m.t + ih + 17 + 11, class: "tick tz", "text-anchor": "end" }, g);
    tz.textContent = TZ;
  }
  for (const t of xs.ticks) {
    const x = m.l + xs.map(t);
    if (x < m.l - 1 || x > m.l + iw + 1) continue;
    const tx = el("text", { x, y: m.t + ih + 17, class: "tick", "text-anchor": "middle" }, g);
    tx.textContent = xFmt ? xFmt(t) : xTime ? fmtTime(t, span) : fmtNum(t);
  }
}

function scale(min, max, size, invert, ticksFn, fixedTicks, integer) {
  if (min === max) { min -= 1; max += 1; }
  const map = (v) => {
    const r = (v - min) / (max - min);
    return invert ? size - r * size : r * size;
  };
  return { min, max, map, ticks: fixedTicks || (ticksFn ? ticksFn(min, max) : niceTicks(min, max, 5, integer)), inv: (px) => min + ((invert ? size - px : px) / size) * (max - min) };
}

function empty(container, msg) {
  container.replaceChildren();
  const d = document.createElement("div");
  d.className = "viz-empty";
  d.textContent = msg || "No data yet";
  container.appendChild(d);
}

// series: [{name, points:[[x,y]...], color, step?, dots?}]
export function lineChart(container, series, opts = {}) {
  series = series.filter((s) => s.points && s.points.length);
  if (!series.length) return empty(container, opts.emptyMsg);
  const f = frame(container, opts);
  const xTime = opts.xTime !== false;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of series) for (const [x, y] of s.points) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  if (opts.xmin != null) xmin = opts.xmin;
  if (opts.xmax != null) xmax = opts.xmax;
  if (opts.zero !== false && ymin > 0) ymin = 0;
  if (ymax === ymin) ymax = ymin + 1;
  const ypad = (ymax - ymin) * 0.05;
  const xs = scale(xmin, xmax, f.iw, false, xTime ? timeTicks : undefined);
  if (opts.ymin != null) ymin = opts.ymin;
  const allInt = series.every((s) => s.points.every((p) => Number.isInteger(p[1])));
  const ys = scale(ymin, opts.ymax != null ? opts.ymax : ymax + ypad, f.ih, true, undefined, opts.yTicks, allInt);
  axes(f, xs, ys, xTime, opts.yFmt, opts.xFmt);
  const g = el("g", { transform: `translate(${f.m.l},${f.m.t})` }, f.svg);
  for (const s of series) {
    let d = "";
    s.points.forEach(([x, y], i) => {
      const px = xs.map(x).toFixed(1), py = ys.map(y).toFixed(1);
      if (i === 0) d += `M${px},${py}`;
      else if (s.step) d += `H${px}V${py}`;
      else d += `L${px},${py}`;
    });
    if (s.dots) {
      for (const [x, y] of s.points) el("circle", { cx: xs.map(x), cy: ys.map(y), r: 3, fill: s.color, class: "dot" }, g);
    } else {
      el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, g);
    }
  }
  // crosshair
  const cross = el("line", { y1: 0, y2: f.ih, class: "crosshair", visibility: "hidden" }, g);
  const hit = el("rect", { x: 0, y: 0, width: f.iw, height: f.ih, fill: "transparent" }, g);
  hit.addEventListener("pointermove", (evt) => {
    const box = hit.getBoundingClientRect();
    const xv = xs.inv(evt.clientX - box.left);
    let best = null;
    const rows = [];
    for (const s of series) {
      const pts = s.points;
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < xv) lo = mid + 1; else hi = mid; }
      let i = lo;
      if (i > 0 && Math.abs(pts[i - 1][0] - xv) < Math.abs(pts[i][0] - xv)) i--;
      if (s.step && pts[i][0] > xv && i > 0) i--;
      if (!best || Math.abs(pts[i][0] - xv) < Math.abs(best - xv)) best = pts[i][0];
      rows.push({ color: s.color, value: (opts.yFmt || fmtNum)(pts[i][1]), label: s.name });
    }
    cross.setAttribute("x1", xs.map(best)); cross.setAttribute("x2", xs.map(best));
    cross.setAttribute("visibility", "visible");
    showTip(evt, opts.xFmt ? opts.xFmt(best) : xTime ? fmtDateTime(best) : fmtNum(best), rows);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  legend(container, series.map((s) => ({ ...s, kind: s.dots ? "dot" : "line" })));
}

// points: [{x, y, color, label, detail, onClick}] — per-point hover with 24px hit target
export function scatter(container, groups, opts = {}) {
  groups = groups.filter((g) => g.points.length);
  if (!groups.length) return empty(container, opts.emptyMsg);
  const f = frame(container, opts);
  const xTime = opts.xTime !== false;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const gr of groups) for (const p of gr.points) {
    xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x);
    ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
  }
  if (opts.xmin != null) xmin = opts.xmin;
  if (opts.xmax != null) xmax = opts.xmax;
  if (opts.zero !== false && ymin > 0) ymin = 0;
  if (opts.ymax != null) ymax = opts.ymax;
  const xs = scale(xmin, xmax, f.iw, false, xTime ? timeTicks : undefined);
  const ys = scale(ymin, ymax + (ymax - ymin) * 0.05 || 1, f.ih, true, undefined, opts.yTicks);
  axes(f, xs, ys, xTime, opts.yFmt, opts.xFmt);
  const g = el("g", { transform: `translate(${f.m.l},${f.m.t})` }, f.svg);
  const all = [];
  for (const gr of groups) for (const p of gr.points) {
    const cx = xs.map(p.x), cy = ys.map(p.y);
    el("circle", { cx, cy, r: opts.r || 4, fill: gr.color, class: "dot" }, g);
    all.push({ cx, cy, p, gr });
  }
  // nearest-point hover layer
  const hit = el("rect", { x: 0, y: 0, width: f.iw, height: f.ih, fill: "transparent" }, g);
  const ring = el("circle", { r: 7, class: "hover-ring", visibility: "hidden" }, g);
  let cur = null;
  hit.addEventListener("pointermove", (evt) => {
    const box = hit.getBoundingClientRect();
    const mx = evt.clientX - box.left, my = evt.clientY - box.top;
    let best = null, bd = 24 * 24;
    for (const a of all) {
      const d = (a.cx - mx) ** 2 + (a.cy - my) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    cur = best;
    if (!best) { ring.setAttribute("visibility", "hidden"); hideTip(); hit.style.cursor = ""; return; }
    ring.setAttribute("cx", best.cx); ring.setAttribute("cy", best.cy); ring.setAttribute("visibility", "visible");
    hit.style.cursor = best.p.onClick ? "pointer" : "";
    const title = best.p.label || (xTime ? fmtDateTime(best.p.x) : fmtNum(best.p.x));
    showTip(evt, title, [{ color: best.gr.color, value: (opts.yFmt || fmtNum)(best.p.y), label: best.gr.name }, ...(best.p.detail || [])]);
  });
  hit.addEventListener("pointerleave", () => { ring.setAttribute("visibility", "hidden"); hideTip(); cur = null; });
  hit.addEventListener("click", () => cur && cur.p.onClick && cur.p.onClick());
  legend(container, groups.map((g) => ({ ...g, kind: "dot" })));
}

// Stacked bars over time. buckets: sorted x values; stacks: [{name, color, values: Map(x -> n)}]
export function stackedBars(container, buckets, stacks, opts = {}) {
  if (!buckets.length) return empty(container, opts.emptyMsg);
  const f = frame(container, opts);
  const width = opts.bucketMs || (buckets.length > 1 ? buckets[1] - buckets[0] : 60e3);
  const xmin = opts.xmin ?? buckets[0], xmax = (opts.xmax ?? buckets[buckets.length - 1]) + width;
  let ymax = 0;
  for (const b of buckets) {
    let s = 0;
    for (const st of stacks) s += st.values.get(b) || 0;
    ymax = Math.max(ymax, s);
  }
  const xs = scale(xmin, xmax, f.iw, false, opts.xTime === false ? undefined : timeTicks);
  const ys = scale(0, ymax * 1.05 || 1, f.ih, true);
  axes(f, xs, ys, opts.xTime !== false, opts.yFmt, opts.xFmt);
  const g = el("g", { transform: `translate(${f.m.l},${f.m.t})` }, f.svg);
  const bw = Math.max(1, xs.map(xmin + width) - xs.map(xmin) - (xs.map(xmin + width) - xs.map(xmin) > 4 ? 2 : 0));
  for (const b of buckets) {
    let acc = 0;
    const x = xs.map(b);
    const rows = [];
    for (const st of stacks) {
      const v = st.values.get(b) || 0;
      if (!v) continue;
      const y0 = ys.map(acc), y1 = ys.map(acc + v);
      const hgt = Math.max(0, y0 - y1 - (stacks.length > 1 ? 1 : 0));
      el("rect", { x, y: y1, width: bw, height: Math.max(hgt, 1), fill: st.color, class: "bar" }, g);
      acc += v;
      rows.push({ color: st.color, value: fmtNum(v), label: st.name });
    }
    const hit = el("rect", { x: x - 1, y: 0, width: bw + 2, height: f.ih, fill: "transparent" }, g);
    hit.addEventListener("pointermove", (evt) => {
      hit.setAttribute("class", "bar-hover");
      showTip(evt, opts.xFmt ? opts.xFmt(b) : opts.xTime === false ? fmtNum(b) : fmtDateTime(b), rows.length ? rows.slice().reverse() : [{ value: "0", label: "" }]);
    });
    hit.addEventListener("pointerleave", () => { hit.setAttribute("class", ""); hideTip(); });
    if (opts.onClick) hit.addEventListener("click", () => opts.onClick(b));
  }
  legend(container, stacks.map((s) => ({ ...s, kind: "bar" })));
}

export function histogram(container, values, opts = {}) {
  values = values.filter((v) => v != null && Number.isFinite(v));
  if (!values.length) return empty(container, opts.emptyMsg);
  values.sort((a, b) => a - b);
  const lo = opts.min ?? values[0];
  const hi = opts.max ?? values[Math.floor(values.length * 0.99)] ?? values[values.length - 1];
  const nb = opts.bins || 30;
  const w = opts.integer ? Math.max(1, Math.ceil((hi - lo + 1) / nb)) : (hi - lo) / nb || 1;
  const counts = new Map();
  const buckets = [];
  for (let i = 0; i < nb; i++) { buckets.push(lo + i * w); counts.set(lo + i * w, 0); }
  for (const v of values) {
    const i = Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / w)));
    counts.set(buckets[i], counts.get(buckets[i]) + 1);
  }
  const fmt = opts.xFmt || fmtNum;
  stackedBars(container, buckets, [{ name: opts.name || "count", color: opts.color || css("--series-1"), values: counts }], {
    ...opts, xTime: false, bucketMs: w,
    xFmt: (x) => (opts.integer ? (w === 1 ? fmt(x) : `${fmt(x)} – ${fmt(x + w - 1)}`) : `${fmt(x)} – ${fmt(x + w)}`),
  });
  // axis labels use bucket start; tooltip uses the range
  const median = values[Math.floor(values.length / 2)];
  const p90 = values[Math.floor(values.length * 0.9)];
  const note = document.createElement("div");
  note.className = "viz-note";
  note.textContent = `n=${values.length} · median ${fmt(median)} · p90 ${fmt(p90)} · max ${fmt(values[values.length - 1])}`;
  container.appendChild(note);
}

export function bucketize(points, bucketMs) {
  const m = new Map();
  for (const t of points) {
    const b = Math.floor(t / bucketMs) * bucketMs;
    m.set(b, (m.get(b) || 0) + 1);
  }
  return m;
}

export function bucketRange(xmin, xmax, bucketMs) {
  const out = [];
  for (let b = Math.floor(xmin / bucketMs) * bucketMs; b <= xmax; b += bucketMs) out.push(b);
  return out;
}

export function pickBucket(spanMs, target = 80) {
  const steps = [10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 86400e3];
  return steps.find((s) => spanMs / s <= target) || 86400e3;
}
