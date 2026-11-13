/**
 * Resona Box, face on, measured from the product photo: a tall rounded slab
 * (about 1:2). The top plate has SELECTOR, two top corner brackets, a smooth
 * round push button and the LIVTRA | RESONA BOX line at its foot; the screen
 * shows IN/OUT meter cells on one row, the highlighted preset line with its
 * number and sliders glyph, and five little pedals (GATE COMP RESONA NAM CAB);
 * the bottom plate has a small button, the big CUSTOMIZE button and two bottom
 * corner brackets. One jack each side: the left one higher.
 * The camera looks straight down, because the flat face is the concept.
 *
 * Hosted in the web editor, mount takes `onPick(i)`, called with 0-4 when a
 * block icon is clicked and 5 for the selector knob, and returns
 * `show(state)`: { num, name, blocks: [{ label, on, fault }], selected, level: [in, out] }.
 * The screen's text is the only lettering, set by the page's CSS.
 *
 * The pattern: discrete items (Riffle), hit-tested on their rest centres.
 */
const {
  Cam, circ, fit, poly, proj, ringAt, rrect, open, seg,
  tset, tval, tween, tdone, disposer, mk, place, pointer, register, solid, put,
} = HL;

// Geometry measured from the product photo (slab 416 x 844 px, scaled to W = 100).
const W = 100, H = 203, BR = 9.6;                                 // the slab
const TOP = [4.8, 4.8, 95.2, 59.2], BOT = [4.8, 121.2, 95.2, 198.4]; // the two raised plates
const SEL = [50, 32.7, 18, 15, 12.4];                             // selector: x, y, ring, ring inner, cap
const CUS = [50, 165, 19.7, 16.8, 15.2];                          // customize: x, y, ring, ring inner, cap
const LED = [50, 132, 4.8, 3.2];                                  // small button above it
const SCR = [7.2, 64.4, 92.8, 116.2], DSP = [13.5, 70.2, 86.5, 109.6]; // bezel and the display
const MY = 73.8, MIN = [21.9, 46.3], MOUT = [58.7, 83.2], CELLS = 10;   // IN/OUT meter cells
const PY = 80.8;                                                  // preset line baseline
const IX = [20.7, 35.4, 50, 64.6, 79.3], IY = 96.6, IW = 4.6, IH = 6; // five pedal icons
const JACKS = [[-1, 81.9], [1, 113.2]], JW = 8.6, JH = 30;        // left jack higher, right lower
const PICK = 16;

const at = (ring, cx, cy) => ring.map((q) => ({ ...q, u: q.u + cx, v: q.v + cy }));

function mount({ stage, svg, read, onPick }, value) {
  const bag = disposer();
  let travel = value;

  const C = Cam(0, 1, 1.46);                                  // 203 tall fits the 320-high stage
  fit(C, [[-JW, 0, 0], [W + JW, H, 0]], 200, 160);
  const P = proj(C);
  const flat = (ring) => poly(ringAt(P, ring, 0));
  const part = (parent, outer, inner, cls) => {
    const el = solid(parent);
    put(el, { sil: flat(outer), crease: inner ? flat(inner) : "" });
    if (cls) el.sil.setAttribute("class", `sil ${cls}`);
    return el;
  };
  const text = (parent, x, y, str, cls, anchor = "start") => {
    const [sx, sy] = P(x, y, 0);
    const t = mk("text", { x: sx.toFixed(2), y: sy.toFixed(2), class: `hl-t ${cls || ""}`, "text-anchor": anchor }, parent);
    t.textContent = str;
    return t;
  };
  const line = (parent, pts, cls = "nf lo") => mk("path", { d: open(pts.map(([x, y]) => P(x, y, 0))), class: cls }, parent);
  const bracket = (parent, x, y, dx, dy, k = 5.2) => line(parent, [[x, y + dy * k], [x, y], [x + dx * k, y]], "nf");
  const round = (parent, x, y, r, inner) => part(parent, at(circ(r, 96), x, y), inner ? at(circ(inner, 96), x, y) : null);

  const g = mk("g", {}, svg);
  // Jacks first: the slab covers all of each but the part that stands out at the side.
  for (const [side, y] of JACKS) {
    const x0 = side < 0 ? -JW : W - 3, x1 = side < 0 ? 3 : W + JW;
    part(g, rrect(x0, y - JH / 2, x1, y + JH / 2, 3.2, 6), rrect(x0 + (side < 0 ? 1.6 : 0), y - JH / 2 + 3, x1 - (side < 0 ? 0 : 1.6), y + JH / 2 - 3, 2, 6));
  }
  part(g, rrect(0, 0, W, H, BR, 8), rrect(1.8, 1.8, W - 1.8, H - 1.8, BR - 1.8, 8));

  // Top plate: SELECTOR, its two top corner brackets, the smooth round button, the brand line.
  part(g, rrect(...TOP, 6.6, 6), null);
  text(g, 50, 11.4, "SELECTOR", "lab", "middle");
  bracket(g, 11.4, 12.6, 1, 1);
  bracket(g, 88.6, 12.6, -1, 1);
  const selRing = round(g, SEL[0], SEL[1], SEL[2], SEL[3]);
  const selCap = round(g, SEL[0], SEL[1], SEL[4], SEL[4] - 1.6);
  text(g, 50, 56.2, "LIVTRA  |  RESONA BOX", "brand", "middle");

  // The screen: bezel, then the display with its three rows.
  part(g, rrect(...SCR, 6, 6), rrect(...DSP, 2.6, 4));
  text(g, 15.4, MY + 1.3, "IN", "mini");
  text(g, 52.6, MY + 1.3, "OUT", "mini");
  const cells = [MIN, MOUT].map(([a, b]) => Array.from({ length: CELLS }, (_, k) => {
    const w = (b - a) / CELLS, x = a + k * w;
    return mk("path", { d: flat(rrect(x + 0.35, MY - 1.1, x + w - 0.35, MY + 1.1, 0.3, 2)), class: "nf lo" }, g);
  }));
  part(g, rrect(14.9, PY - 4.6, 58.4, PY + 1.6, 0.8, 3), null, "lo");       // the highlighted preset box
  line(g, [[15.6, PY - 4], [15.6, PY + 1]], "nf hi");                       // its left accent bar
  const pNum = text(g, 17.6, PY, "1", "pnum");
  const pName = text(g, 23, PY, "", "pname");
  const pRight = text(g, 64.4, PY, "", "pnum");
  for (const y of [-3.2, -1.2, 0.8]) line(g, [[77.4, PY + y], [82, PY + y]]); // the sliders glyph
  const icons = IX.map((x) => {                                              // little pedals
    const el = part(g, rrect(x - IW, IY - IH, x + IW, IY + IH, 1.2, 4), null);
    for (const dx of [-1.9, 1.9]) round(g, x + dx, IY - IH + 2.2, 1);
    const label = text(g, x, IY + 1.8, "", "icon", "middle");
    const dot = mk("circle", { r: 0.9, class: "dot off" }, g);
    place(dot, P(x, IY + IH - 1.6, 0));
    return { el, label, dot };
  });

  // Bottom plate: the small button, the big CUSTOMIZE button, two bottom corner brackets.
  part(g, rrect(...BOT, 6.6, 6), null);
  round(g, LED[0], LED[1], LED[2], LED[3]);
  const led = mk("circle", { r: 1.2, class: "dot" }, g);
  place(led, P(LED[0], LED[1], 0));
  round(g, CUS[0], CUS[1], CUS[2], CUS[3]);
  round(g, CUS[0], CUS[1], CUS[4], CUS[4] - 1.6);
  bracket(g, 11.4, 192.6, 1, -1);
  bracket(g, 88.6, 192.6, -1, -1);
  text(g, 50, 194.2, "CUSTOMIZE", "lab", "middle");

  // Motion: the meters ease to their level (the selector is a smooth push button: nothing turns).
  const angle = tween(0);
  const lv = [tween(0, 300), tween(0, 300)];
  const drawn = [NaN, NaN];
  function drawKnob() {}
  function drawMeter(i, v) {
    const lit = Math.round(v * CELLS);
    if (lit === drawn[i]) return;
    drawn[i] = lit;
    cells[i].forEach((c, k) => c.setAttribute("class", k < lit ? (k >= CELLS - 2 ? "fo meter hot" : "fo meter") : "nf lo"));
  }
  const B = register(stage, (_dt, now) => {
    drawKnob(tval(angle, now));
    lv.forEach((t, i) => drawMeter(i, tval(t, now)));
    return !tdone(angle, now) || lv.some((t) => !tdone(t, now));
  });
  bag.add(B.unregister);

  const targets = IX.map((x) => P(x, IY, 0)).concat([P(SEL[0], SEL[1], 0)]);
  function hit([sx, sy]) {
    let best = -1, bd = PICK;
    targets.forEach(([tx, ty], i) => { const d = Math.hypot(sx - tx, sy - ty) / (i === 5 ? 2 : 1); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  let state = { num: 1, name: "", blocks: [], selected: 0, level: [0, 0] };
  let hover = -1;
  function paint() {
    const s = state;
    pNum.textContent = s.num == null ? "–" : String(s.num);
    pName.textContent = s.name || "";
    pRight.textContent = s.right || "";
    icons.forEach((ic, i) => {
      const b = s.blocks[i];
      ic.label.textContent = b ? b.label : "";
      const on = !!(b && b.on);
      const sel = i === s.selected || i === hover;
      ic.el.sil.setAttribute("class", sel ? "sil hi" : on ? "sil" : "sil lo");
      ic.label.setAttribute("class", `hl-t icon${on ? " on" : ""}${sel ? " sel" : ""}${b && b.fault ? " fault" : ""}`);
      ic.dot.setAttribute("class", i === s.selected ? "dot" : on ? "dot m" : "dot off");
    });
    selRing.sil.classList.toggle("hi", hover === 5);
    selCap.sil.classList.toggle("hi", hover === 5);
    read.textContent = s.name;
  }
  function show(next) {
    state = { ...state, ...next };
    const now = performance.now();
    const n = state.num == null ? 1 : state.num;
    lv.forEach((t, i) => tset(t, Math.max(0, Math.min(1, (state.level || [0, 0])[i] || 0)) * travel, now, 0));
    paint();
    B.wake();
  }
  paint();

  bag.add(pointer(stage, {
    move: (p) => { const a = hit(p); if (a !== hover) { hover = a; stage.style.cursor = a >= 0 && onPick ? "pointer" : "default"; paint(); } },
    down: (p) => { const a = hit(p); if (a >= 0 && onPick) onPick(a); },
    leave: () => { hover = -1; paint(); },
  }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { travel = v; show({}); },
    show,
    targets,
    destroy: bag.dispose,
  };
}

hairline({
  name: "resona",
  means: "The Resona Box, face on: selector knob, screen with the preset and its five blocks, and the customize knob.",
  rules: [1, 2, 4, 10],
  range: [0.5, 1, 1],
  tour: [],
  mount,
});
