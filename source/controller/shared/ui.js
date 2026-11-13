// Draws a Box App controller from its profile (profile.js), in one of two looks:
//   web    the Resona Box website editor: slate page, the Box in chalk lines, a paper sheet
//   mobile the companion app's control surface: light cards, signal-chain buttons, steppers
// The App's pages play the part of the Box's five blocks. Values come from AppLink (link.js).
import {AppLink, lo, hi, isSteps} from './link.js';
import {target} from './target.js';

const DEMO = new URLSearchParams(location.search).get('demo') === '1';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(9)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}

export function format(c, v) {
  if (c.format) return c.format(v);
  if (c.kind === 'toggle') return v ? (c.on || 'On') : (c.off || 'Off');
  if (isSteps(c)) return c.options[v] ?? '–';
  return `${v}${c.unit ? (c.unit === '%' ? '%' : ' ' + c.unit) : ''}`;
}

export function mount(profile, mode) {
  const link = new AppLink(profile);
  const app = document.querySelector('#app');
  const pages = profile.pages.slice(0, 5);
  let sel = 0, built = '', updates = [], figure = null;
  const byId = Object.fromEntries(pages.flatMap(p => p.controls).map(c => [c.id, c]));

  document.title = `${profile.name} Controller`;
  document.documentElement.style.setProperty('--accent', profile.accent || '#ce5b32');

  /* ---- the controls ---- */

  function stepBy(c, dir) { link.set(c, link.values[c.id] + dir * (c.step || 1)); }

  function rangeControl(c) {
    const read = h('span', {class: 'param-read'});
    const range = h('input', {class: 'range', type: 'range', min: lo(c), max: hi(c), step: c.step || 1, 'aria-label': c.label,
      oninput: e => link.set(c, Number(e.target.value)),
      onpointerdown: () => link.hold(c, true), onpointerup: () => link.hold(c, false), onpointercancel: () => link.hold(c, false),
      onchange: () => link.hold(c, false),
      ondblclick: () => c.def != null && link.set(c, c.def)});
    const input = h('input', {class: 'step-input', inputmode: 'numeric', 'aria-label': `${c.label} value`, readonly: c.format ? true : null,
      onchange: e => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) link.set(c, n); else update(); }});
    const minus = h('button', {class: 'step-btn', type: 'button', text: '−', 'aria-label': `Decrease ${c.label}`, onclick: () => stepBy(c, -1)});
    const plus = h('button', {class: 'step-btn', type: 'button', text: '+', 'aria-label': `Increase ${c.label}`, onclick: () => stepBy(c, 1)});
    function update() {
      const v = link.values[c.id];
      read.textContent = format(c, v);
      if (document.activeElement !== range) range.value = v;
      if (document.activeElement !== input) input.value = c.format ? c.format(v).split(' · ')[0] : v;
      minus.disabled = v <= lo(c); plus.disabled = v >= hi(c);
    }
    updates.push(update); update();
    return h('div', {class: 'param'},
      h('div', {class: 'param-head'}, h('span', {class: 'flabel', text: c.label}), read),
      h('div', {class: 'param-ctl'}, range, h('div', {class: 'stepper'}, minus, input, plus)));
  }

  function choiceControl(c) {
    const opts = c.kind === 'toggle' ? [c.off || 'Off', c.on || 'On'] : c.options;
    const read = h('span', {class: 'param-read'});
    if (opts.length > 4) {
      const select = h('select', {class: 'select', 'aria-label': c.label, onchange: e => link.set(c, Number(e.target.value))},
        opts.map((o, i) => h('option', {value: i, text: o})));
      const update = () => { select.value = link.values[c.id]; read.textContent = format(c, link.values[c.id]); };
      updates.push(update); update();
      return h('div', {class: 'param choice'}, h('div', {class: 'param-head'}, h('span', {class: 'flabel', text: c.label}), read), select);
    }
    const btns = opts.map((o, i) => h('button', {class: 'seg-btn', type: 'button', text: o, onclick: () => link.set(c, i)}));
    const update = () => btns.forEach((b, i) => { b.classList.toggle('on', i === link.values[c.id]); b.setAttribute('aria-pressed', String(i === link.values[c.id])); });
    updates.push(update); update();
    return h('div', {class: `param ${c.kind === 'toggle' ? 'toggle' : 'choice'}`},
      h('div', {class: 'param-head'}, h('span', {class: 'flabel', text: c.label})),
      h('div', {class: 'seg light', role: 'group', 'aria-label': c.label}, btns));
  }

  function readout(c) {
    const val = h('span', {class: 'readout-val'});
    const update = () => { val.textContent = format(c, link.values[c.id]); };
    updates.push(update); update();
    return h('div', {class: 'param readout'}, h('span', {class: 'flabel', text: c.label}), val);
  }

  function pad(c) {
    const b = h('button', {class: 'pad', type: 'button', 'aria-label': c.label},
      h('span', {class: 'pad-label', text: c.label}), c.key && mode === 'web' ? h('kbd', {text: c.key}) : null);
    let down = false;
    const press = on => { if (on === down) return; down = on; b.classList.toggle('down', on); link.press(c, on); };
    b.addEventListener('pointerdown', e => { b.setPointerCapture?.(e.pointerId); press(true); });
    b.addEventListener('pointerup', () => press(false));
    b.addEventListener('pointercancel', () => press(false));
    b.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(true); } });
    b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') press(false); });
    if (c.key) keys.set(c.key.toLowerCase(), press);
    return b;
  }

  function xy(c) {
    const cx = byId[c.x], cy = byId[c.y];
    const dot = h('span', {class: 'xy-dot'});
    const surface = h('div', {class: 'xy', role: 'group', 'aria-label': `${c.label}: ${cx.label} across, ${cy.label} up`, tabindex: 0}, dot);
    const put = e => {
      const r = surface.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left - 19) / (r.width - 38))), fy = Math.min(1, Math.max(0, 1 - (e.clientY - r.top - 19) / (r.height - 38)));
      link.set(cx, lo(cx) + fx * (hi(cx) - lo(cx))); link.set(cy, lo(cy) + fy * (hi(cy) - lo(cy)));
    };
    surface.addEventListener('pointerdown', e => { surface.setPointerCapture(e.pointerId); link.hold(cx, true); link.hold(cy, true); surface.classList.add('down'); put(e); });
    surface.addEventListener('pointermove', e => { if (surface.classList.contains('down')) put(e); });
    const up = () => { link.hold(cx, false); link.hold(cy, false); surface.classList.remove('down'); };
    surface.addEventListener('pointerup', up); surface.addEventListener('pointercancel', up);
    surface.addEventListener('keydown', e => {
      const d = {ArrowLeft: [cx, -1], ArrowRight: [cx, 1], ArrowDown: [cy, -1], ArrowUp: [cy, 1]}[e.key];
      if (d) { e.preventDefault(); stepBy(d[0], d[1] * Math.max(1, Math.round((hi(d[0]) - lo(d[0])) / 20))); }
    });
    const update = () => {
      const fx = (link.values[cx.id] - lo(cx)) / (hi(cx) - lo(cx)), fy = (link.values[cy.id] - lo(cy)) / (hi(cy) - lo(cy));
      dot.style.left = `calc(19px + ${fx} * (100% - 38px))`; dot.style.top = `calc(19px + ${1 - fy} * (100% - 38px))`;
    };
    updates.push(update); update();
    return h('div', {class: 'param xy-param'},
      h('div', {class: 'param-head'}, h('span', {class: 'flabel', text: c.label})), surface);
  }

  function control(c) {
    if (c.kind === 'range') return rangeControl(c);
    if (c.kind === 'choice' || c.kind === 'toggle') return choiceControl(c);
    if (c.kind === 'readout') return readout(c);
    if (c.kind === 'xy') return xy(c);
    return null;
  }

  function controls(list) {
    const out = [], items = [];
    let pads = [];
    const flush = () => { if (pads.length) { out.push(h('div', {class: `pads n${Math.min(pads.length, 4)}`}, pads)); pads = []; } };
    for (const c of list) {
      if (c.kind === 'trigger') { pads.push(pad(c)); continue; }
      flush();
      if (c.kind === 'xy') { out.push(control(c)); continue; }
      items.push(c);
      const last = out[out.length - 1];
      if (last && last.classList.contains('params')) last.append(control(c));
      else out.push(h('div', {class: 'params'}, control(c)));
    }
    flush();
    return out;
  }

  /* ---- the frame ---- */

  const keys = new Map();
  const summary = p => { const c = p.controls.find(x => x.kind !== 'trigger' && x.kind !== 'xy'); return c ? format(c, link.values[c.id]) : ''; };

  function chainStrip() {
    return h('div', {class: `chain${pages.length < 5 ? ' few' : ''}`, role: 'tablist', 'aria-label': 'Pages', style: {'--pages': pages.length}}, pages.map((p, i) => {
      const sub = h('span', {class: 'blk-sub'});
      updates.push(() => { sub.textContent = summary(p); });
      sub.textContent = summary(p);
      return h('div', {class: `blk lit${i === sel ? ' sel' : ''}`, style: {'--c': p.color || 'var(--accent)'}},
        h('button', {class: 'blk-pick', type: 'button', role: 'tab', 'aria-selected': String(i === sel), onclick: () => pick(i)},
          h('span', {class: 'blk-key', text: p.key}),
          h('span', {class: 'blk-text'}, h('span', {class: 'blk-name', text: p.label}), sub)),
        mode === 'mobile' ? h('span', {class: 'chain-dot'}) : null);
    }));
  }

  function sheet() {
    const p = pages[sel];
    return h('article', {class: 'sheet', style: {'--c': p.color || 'var(--accent)'}},
      h('header', {class: 'sheet-head'},
        h('span', {class: `key${p.key.length > 1 ? ' wide' : ''}`, text: p.key, 'aria-hidden': 'true'}),
        h('div', {class: 'sheet-titles'}, h('h2', {text: p.title || p.label}))),
      h('div', {class: 'sheet-body'}, h('div', {class: 'sheet-main'}, h('div', {class: 'sec'}, controls(p.controls)))));
  }

  function connPill() {
    const conn = document.querySelector('#conn');
    if (!conn) return;
    conn.replaceChildren(link.state === 'live'
      ? h('button', {class: 'conn-pill', type: 'button', title: 'Disconnect', onclick: () => !DEMO && link.disconnect()},
          h('span', {class: 'dot'}), DEMO ? 'Demo Box' : 'Resona Box', h('span', {class: 'muted', text: `${profile.name} ${target.appVersion}`}))
      : h('button', {class: 'btn chalk', type: 'button', disabled: link.state === 'connecting', onclick: () => link.connect(),
          text: link.state === 'connecting' ? 'Connecting…' : 'Connect'}));
  }

  function boxFigure() {
    if (figure) return figure.wrap;
    const def = window.RESONA_FIGURE;
    const wrap = h('div', {class: 'fig-crop'});
    figure = {wrap, handle: null};
    if (!def || !window.HL) return wrap;
    const stage = h('div', {class: 'fig-stage', 'data-hairline': def.name, role: 'img', 'aria-label': `The Resona Box running ${profile.name}`});
    wrap.append(stage);
    HL.inject(document);
    const svg = HL.mk('svg', {viewBox: '0 0 400 320', 'aria-hidden': 'true'}, stage);
    figure.handle = def.mount({stage, svg, read: {textContent: ''}, onPick: i => pick(i === 5 ? (sel + 1) % pages.length : i)}, def.range[1]);
    return wrap;
  }
  function syncFigure() {
    if (!figure?.handle) return;
    figure.handle.show({num: '', name: (profile.screen || profile.name).toUpperCase(), right: link.state === 'live' ? (DEMO ? 'DEMO' : 'LIVE') : '',
      blocks: [0, 1, 2, 3, 4].map(i => pages[i] ? {label: pages[i].label, on: true} : null),
      selected: link.state === 'live' ? sel : -1, level: link.meters});
    figure.wrap.style.setProperty('--sel', pages[sel].color || '#fff');
  }

  function meterStrip() {
    const bars = [0, 1].map(() => h('i'));
    const el = h('span', {class: 'live-meter', 'aria-hidden': 'true'}, h('b', {text: 'IN'}), bars[0], h('b', {text: 'OUT'}), bars[1]);
    link.addEventListener('meter', () => bars.forEach((b, i) => b.style.setProperty('--m', link.meters[i])));
    return el;
  }

  function connectScreen() {
    const busy = link.state === 'connecting';
    if (mode === 'mobile') {
      return h('div', {class: 'mobile-empty'},
        h('div', {class: 'empty-mark', 'aria-hidden': 'true', text: pages[0].key}),
        h('span', {class: 'eyebrow', text: profile.name.toUpperCase()}),
        h('h1', {text: busy ? 'Finding the App…' : 'Ready when you are.'}),
        busy ? h('div', {class: 'loading-bars', 'aria-label': 'Connecting'}, h('i'), h('i'), h('i'), h('i'), h('i')) : null,
        link.error ? h('p', {class: 'connection-error', text: link.error}) : h('p', {text: window.CreatorHost ? 'Connect your Box above.' : 'Connect your Box with USB.'}),
        !busy && (link.error || !window.CreatorHost) ? h('button', {class: 'btn primary', type: 'button', text: link.error ? 'Try again' : 'Connect', onclick: () => link.connect()}) : null);
    }
    return h('div', {class: 'connect'},
      h('div', {class: 'connect-copy'},
        h('h1', {text: `Play ${profile.name}`}),
        h('p', {text: `Connect the Resona Box running ${profile.name} ${target.appVersion} with USB, then press Connect.`})),
      h('div', {class: 'connect-fig'}, boxFigure()),
      h('div', {class: 'connect-actions'},
        h('button', {class: 'btn chalk big', type: 'button', disabled: busy, text: busy ? 'Connecting…' : 'Connect', onclick: () => link.connect()})),
      link.error ? h('p', {class: 'warn', text: link.error}) : null);
  }

  function editor() {
    const title = h('div', {class: 'patch'},
      h('div', {class: 'patch-name off'}, h('span', {class: 'patch-title', text: profile.name.toUpperCase()})));
    if (mode === 'mobile') {
      return h('div', {class: 'editor mobile-editor'},
        h('section', {class: 'stage'}, title),
        h('div', {class: 'signal-caption'}, h('span', {text: 'PAGES'}), meterStrip()),
        chainStrip(), sheet(),
        h('div', {class: 'live-foot'}, h('span', {class: 'live-dot'}), h('span', {text: DEMO ? 'Demo · no Box connected' : 'Live on your Box'})));
    }
    return h('div', {class: 'editor'},
      h('section', {class: 'stage'}, title),
      h('div', {class: 'layout'},
        h('div', {class: 'box-col'}, boxFigure(), h('p', {class: 'hint fig-hint', text: 'Click a page on the screen, or the selector for the next one.'})),
        h('div', {class: 'edit-col'}, chainStrip(), sheet())));
  }

  function render() {
    updates = [];
    keys.clear();
    app.replaceChildren(link.state === 'live' ? editor() : connectScreen());
    built = link.state + sel;
    connPill(); syncFigure();
  }
  function pick(i) { if (i === sel || !pages[i]) return; sel = i; render(); }

  link.addEventListener('change', () => {
    if (built !== link.state + sel) render();
    else { updates.forEach(u => u()); syncFigure(); connPill(); }
  });
  link.addEventListener('meter', syncFigure);

  document.addEventListener('keydown', e => {
    if (e.target.closest?.('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (link.state !== 'live') return;
    const n = Number(e.key);
    if (n >= 1 && n <= pages.length) { pick(n - 1); return; }
    const press = keys.get(e.key.toLowerCase());
    if (press) { e.preventDefault(); press(true); }
  });
  document.addEventListener('keyup', e => { const press = keys.get(e.key.toLowerCase()); if (press) press(false); });

  render();
  if (DEMO) link.connect();
  else if (window.CreatorHost) {
    window.addEventListener('creatorstatechange', e => { if (e.detail.connected) link.connect(); else link.lost('Disconnected'); });
    window.creator.connection().then(s => { if (s.connected) link.connect(); });
  }
  return link;
}
