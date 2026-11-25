// Tiny dependency-free SVG charts: a line chart with crosshair tooltip, and a bar chart
// with per-bar tooltip. Colors come from CSS custom properties (--series-1..4 etc.).
(function () {
  const NS = "http://www.w3.org/2000/svg";

  function s(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.append(n);
    return n;
  }
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // "Nice" axis ticks (1, 2, 5 × 10^n steps).
  function ticks(min, max, count = 5) {
    if (min === max) { min -= 10; max += 10; }
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((st) => raw <= st) || 10 * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target;
      if (el._render && el.clientWidth && el.clientWidth !== el._lastW) el._render();
    }
  });
  function mount(el, render) {
    el._render = () => { el._lastW = el.clientWidth; render(); };
    ro.observe(el);
    el._render();
  }

  function empty(el, msg) {
    el.replaceChildren(h("div", "chart-empty", msg));
  }

  function tooltip(el) {
    const tip = h("div", "chart-tip");
    tip.hidden = true;
    el.append(tip);
    return tip;
  }
  function placeTip(el, tip, px, py) {
    tip.hidden = false;
    const w = tip.offsetWidth, W = el.clientWidth;
    let left = px + 14;
    if (left + w > W - 4) left = px - w - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(0, py - tip.offsetHeight / 2)}px`;
  }

  /**
   * Line chart.
   * opts.series: [{ name, color, points: [[x, y, tag?], ...] }]
   * opts.step:   draw as steps (value holds until the next point)
   * opts.xLabel: (x) => string for tooltip heading
   * opts.tagLabel: (tag) => string shown per series in tooltip (optional)
   */
  function line(el, opts) {
    mount(el, () => {
      const series = opts.series.filter((se) => se.points.length > 1);
      if (!series.length) return empty(el, opts.emptyText || "No data yet.");

      const W = el.clientWidth || 600, H = opts.height || 280;
      const multi = series.length > 1;
      const m = { t: 14, r: multi ? 92 : 18, b: 30, l: 46 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;

      const all = series.flatMap((se) => se.points);
      const xMax = Math.max(1, ...all.map((p) => p[0]));
      const yT = ticks(Math.min(0, ...all.map((p) => p[1])), Math.max(0, ...all.map((p) => p[1])));
      const y0 = yT[0], y1 = yT[yT.length - 1];
      const X = (x) => m.l + (x / xMax) * iw;
      const Y = (y) => m.t + ih - ((y - y0) / (y1 - y0)) * ih;

      el.replaceChildren();
      if (multi) {
        const legend = h("div", "chart-legend");
        series.forEach((se) => {
          const item = h("span", "legend-item");
          const sw = h("i", "swatch"); sw.style.background = se.color;
          item.append(sw, se.name);
          legend.append(item);
        });
        el.append(legend);
      }
      const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": opts.ariaLabel || "Line chart" });
      el.append(svg);

      // Grid + y labels (zero line slightly stronger).
      yT.forEach((v) => {
        s("line", { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), class: v === 0 ? "zero-line" : "grid-line" }, svg);
        s("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end", class: "axis-text" }, svg).textContent = v;
      });
      // X labels.
      ticks(0, xMax, Math.min(6, xMax))
        .filter((v) => v <= xMax && Number.isInteger(v))
        .filter((v) => !opts.xTitle || X(xMax) - X(v) > 60 || v === 0) // leave room for the axis title
        .forEach((v) => {
        s("text", { x: X(v), y: H - 8, "text-anchor": "middle", class: "axis-text" }, svg).textContent = v;
      });
      if (opts.xTitle) s("text", { x: m.l + iw, y: H - 8, "text-anchor": "end", class: "axis-text axis-title" }, svg).textContent = opts.xTitle;

      // Lines.
      series.forEach((se) => {
        let d = "";
        se.points.forEach((p, i) => {
          if (i === 0) d += `M${X(p[0])},${Y(p[1])}`;
          else if (opts.step) d += `H${X(p[0])}V${Y(p[1])}`;
          else d += `L${X(p[0])},${Y(p[1])}`;
        });
        if (opts.step) d += `H${X(xMax)}`;
        s("path", { d, fill: "none", stroke: se.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
        if (!multi && se.points.length <= 40) {
          se.points.slice(1).forEach((p) => s("circle", { cx: X(p[0]), cy: Y(p[1]), r: 4, fill: se.color, class: "ringed" }, svg));
        }
      });

      // Direct labels at the right end, nudged apart so they never overlap.
      if (multi) {
        const labels = series.map((se) => ({ se, y: Y(se.points[se.points.length - 1][1]) })).sort((a, b) => a.y - b.y);
        for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14);
        labels.forEach(({ se, y }) => {
          s("text", { x: X(xMax) + 8, y: y + 4, class: "direct-label" }, svg).textContent = se.name;
        });
      }

      // Hover: crosshair + tooltip with every series' value at that x.
      const tip = tooltip(el);
      const cross = s("line", { y1: m.t, y2: m.t + ih, class: "crosshair", visibility: "hidden" }, svg);
      const dots = series.map((se) => s("circle", { r: 5, fill: se.color, class: "ringed", visibility: "hidden" }, svg));
      const hit = s("rect", { x: m.l, y: m.t, width: iw + (multi ? 0 : 1), height: ih, fill: "transparent" }, svg);

      const valueAt = (se, x) => {
        let best = null;
        for (const p of se.points) {
          if (p[0] <= x) best = p; else break;
        }
        return best;
      };
      function move(ev) {
        const r = svg.getBoundingClientRect();
        const px = ((ev.clientX - r.left) / r.width) * W;
        const x = Math.max(0, Math.min(xMax, Math.round(((px - m.l) / iw) * xMax)));
        cross.setAttribute("x1", X(x)); cross.setAttribute("x2", X(x));
        cross.setAttribute("visibility", "visible");
        const rows = series.map((se, i) => {
          const p = opts.step ? valueAt(se, x) : se.points.find((q) => q[0] === x) || valueAt(se, x);
          if (p) {
            dots[i].setAttribute("cx", X(opts.step ? x : p[0]));
            dots[i].setAttribute("cy", Y(p[1]));
            dots[i].setAttribute("visibility", "visible");
          }
          return { se, p };
        }).filter((r) => r.p).sort((a, b) => b.p[1] - a.p[1]);

        tip.replaceChildren(h("div", "tip-title", opts.xLabel ? opts.xLabel(x) : `x = ${x}`));
        rows.forEach(({ se, p }) => {
          const row = h("div", "tip-row");
          const sw = h("i", "swatch"); sw.style.background = se.color;
          const tag = opts.tagLabel && p[2] ? ` ${opts.tagLabel(p[2])}` : "";
          row.append(sw, h("span", "tip-name", multi ? se.name : "Score"), h("b", null, `${p[1]}${tag}`));
          tip.append(row);
        });
        placeTip(el, tip, (X(x) / W) * el.clientWidth, ((ev.clientY - r.top) / r.height) * H);
      }
      function leave() {
        tip.hidden = true;
        cross.setAttribute("visibility", "hidden");
        dots.forEach((d) => d.setAttribute("visibility", "hidden"));
      }
      hit.addEventListener("mousemove", move);
      hit.addEventListener("mouseleave", leave);
    });
  }

  /**
   * Bar chart. opts.data: [{ label, value, tip }]; opts.every: show every Nth x label.
   */
  function bars(el, opts) {
    mount(el, () => {
      const data = opts.data;
      if (!data.length) return empty(el, opts.emptyText || "No data yet.");
      const W = el.clientWidth || 600, H = opts.height || 220;
      const m = { t: 12, r: 12, b: 28, l: 38 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const yT = ticks(0, Math.max(4, ...data.map((d) => d.value)), 4).filter((v) => Number.isInteger(v));
      const yMax = yT[yT.length - 1];
      const Y = (v) => m.t + ih - (v / yMax) * ih;
      const band = iw / data.length;
      const bw = Math.max(2, Math.min(28, band - 2)); // 2px surface gap between bars

      el.replaceChildren();
      const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": opts.ariaLabel || "Bar chart" });
      el.append(svg);
      yT.forEach((v) => {
        s("line", { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), class: v === 0 ? "zero-line" : "grid-line" }, svg);
        s("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end", class: "axis-text" }, svg).textContent = v;
      });

      const tip = tooltip(el);
      const every = opts.every || 1;
      const rects = data.map((d, i) => {
        const cx = m.l + band * i + band / 2;
        const top = Y(d.value), base = Y(0), hgt = base - top;
        let bar = null;
        if (d.value > 0) {
          const r = Math.min(4, hgt, bw / 2), x0 = cx - bw / 2, x1 = cx + bw / 2;
          // Rounded data-end on top, square on the baseline.
          bar = s("path", {
            d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`,
            fill: opts.color || "var(--series-1)", class: "bar",
          }, svg);
        }
        if (i % every === 0) s("text", { x: cx, y: H - 8, "text-anchor": "middle", class: "axis-text" }, svg).textContent = d.label;
        // Hit target is the whole column, bigger than the bar.
        const hit = s("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "transparent" }, svg);
        hit.addEventListener("mouseenter", () => {
          svg.classList.add("dim");
          if (bar) bar.classList.add("on");
          tip.replaceChildren(h("div", "tip-title", d.tip || d.label), h("div", "tip-row", `${d.value} vote${d.value === 1 ? "" : "s"}`));
          placeTip(el, tip, (cx / W) * el.clientWidth, (Math.min(top, base - 10) / H) * H);
        });
        hit.addEventListener("mouseleave", () => {
          svg.classList.remove("dim");
          if (bar) bar.classList.remove("on");
          tip.hidden = true;
        });
        return bar;
      });
      return rects;
    });
  }

  window.Charts = { line, bars };
})();
