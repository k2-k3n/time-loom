// The controller's side of controller_link.h: one CC per control on channel 1.
// CC 119 asks the App for everything; CC 116/117 carry its input/output meters.
// Web MIDI in browsers, the companion app's bridge on phones, FakeApp with ?demo=1.
import './creator.js';
import './identity.js';
import {target} from './target.js';

export const CH = 0, CC_METER_IN = 116, CC_METER_OUT = 117, CC_QUERY = 119;
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Every control that carries a value, with its numeric range (choices and toggles are steps). */
export function valued(profile) {
  const out = [];
  for (const page of profile.pages) for (const c of page.controls) {
    if (c.kind === 'xy' || c.kind === 'trigger') continue;
    out.push(c);
  }
  return out;
}
export const triggers = profile => profile.pages.flatMap(p => p.controls.filter(c => c.kind === 'trigger'));
export const isSteps = c => c.kind === 'choice' || c.kind === 'toggle' || (c.kind === 'readout' && c.options);
export function lo(c) { return isSteps(c) ? 0 : c.min; }
export function hi(c) { return c.kind === 'toggle' ? 1 : isSteps(c) ? c.options.length - 1 : c.max; }
export function toCC(c, v) {
  v = clamp(Math.round(v), lo(c), hi(c));
  if (isSteps(c)) return v;
  return hi(c) === lo(c) ? 0 : Math.round((v - lo(c)) * 127 / (hi(c) - lo(c)));
}
export function fromCC(c, cc) {
  if (isSteps(c)) return clamp(cc, lo(c), hi(c));
  return lo(c) + Math.round((hi(c) - lo(c)) * cc / 127);
}

/** The App, as the controller sees it. Fires 'change' (values, meters, connection) and 'pulse' (a pad). */
export class AppLink extends EventTarget {
  constructor(profile) {
    super();
    this.profile = profile;
    this.controls = valued(profile);
    this.byCC = new Map(this.controls.map(c => [c.cc, c]));
    this.values = Object.fromEntries(this.controls.map(c => [c.id, c.def ?? lo(c)]));
    this.meters = [0, 0];
    this.state = 'idle';           // idle | connecting | live | error
    this.error = '';
    this.transport = null;
    this.held = new Set();         // controls under the user's finger: feedback waits
    this.queue = new Map();        // cc -> latest value, sent at most every 30 ms
    this.timer = 0;
    this.heard = false;
  }
  emit(type) { this.dispatchEvent(new Event(type)); }

  async connect() {
    if (this.state === 'connecting' || this.state === 'live') return;
    this.state = 'connecting'; this.error = ''; this.heard = false; this.emit('change');
    try {
      this.transport = DEMO ? fakeApp(this.profile, b => this.receive(b)) : await openDevice(b => this.receive(b), () => this.lost('Disconnected'));
      this.raw([0xb0 | CH, CC_QUERY, 1]);
      const t0 = performance.now();
      while (!this.heard && performance.now() - t0 < 2500) await new Promise(r => setTimeout(r, 50));
      if (!this.heard) throw Error(`${target.appName || this.profile.name} ${target.appVersion} isn't answering. Install this version of the App on the Box.`);
      this.state = 'live'; this.emit('change');
    } catch (e) {
      this.transport?.close(); this.transport = null;
      this.state = 'error'; this.error = e.message || String(e); this.emit('change');
    }
  }
  lost(message) {
    this.transport?.close(); this.transport = null;
    this.state = 'error'; this.error = message; this.meters = [0, 0]; this.emit('change');
  }
  disconnect() { this.transport?.close(); this.transport = null; this.state = 'idle'; this.meters = [0, 0]; this.emit('change'); }

  raw(bytes) { try { this.transport?.send(bytes); } catch (e) { this.lost(e.message); } }

  receive(bytes) {
    if (bytes.length !== 3 || bytes[0] !== (0xb0 | CH)) return;
    const cc = bytes[1], v = bytes[2];
    this.heard = true;
    if (cc === CC_METER_IN || cc === CC_METER_OUT) { this.meters[cc - CC_METER_IN] = v / 127; this.emit('meter'); return; }
    const c = this.byCC.get(cc);
    if (!c || this.held.has(c.id) || this.queue.has(cc)) return;
    const value = fromCC(c, v);
    if (value === this.values[c.id]) return;
    this.values[c.id] = value; this.emit('change');
  }

  /** Sets a value now in the UI; the App's echo confirms it. */
  set(c, value) {
    value = clamp(value, lo(c), hi(c));
    if (!isSteps(c) && c.step) value = Math.round(value / c.step) * c.step;
    this.values[c.id] = fromCC(c, toCC(c, value));
    this.queue.set(c.cc, toCC(c, value));
    if (!this.timer) this.flush();
    this.emit('change');
  }
  flush() {
    this.timer = 0;
    if (!this.queue.size) return;
    for (const [cc, v] of this.queue) this.raw([0xb0 | CH, cc, v]);
    this.queue.clear();
    this.timer = setTimeout(() => this.flush(), 30);
  }
  press(c, down) { this.raw([0xb0 | CH, c.cc, down ? 127 : 0]); if (down) this.emit('pulse'); }
  hold(c, on) { on ? this.held.add(c.id) : this.held.delete(c.id); }
}

async function openDevice(onMessage, onLost) {
  if (!navigator.requestMIDIAccess) throw Error('This browser has no Web MIDI. Use Chrome or Edge, or the Creator Lab app on your phone.');
  const access = await navigator.requestMIDIAccess({sysex: true});
  const pick = ports => [...ports.values()].filter(p => p.state !== 'disconnected' && /resona/i.test(p.name));
  const outputs = pick(access.outputs), inputs = pick(access.inputs);
  if (!outputs.length || !inputs.length) throw Error('No Resona Box found. Connect it with USB and allow MIDI.');
  const output = outputs[0], input = inputs[0];
  const client = new ResonaBridge.Client(bytes => output.send(bytes));
  input.onmidimessage = e => client.handleMessage(e.data);
  try {
    const id = await client.identify();
    if (id.mode !== 'app' || id.appId !== target.appId) throw Error(`The Box is running ${id.appName || 'another App'}. Install ${target.appName} ${target.appVersion} first.`);
    if (id.appVersion !== target.appVersion) throw Error(`The Box has ${target.appName} ${id.appVersion}; this controller is for ${target.appVersion}.`);
  } catch (e) { input.onmidimessage = null; client.close(); throw e; }
  client.close();
  input.onmidimessage = e => onMessage(e.data);
  access.onstatechange = e => { if (e.port.state === 'disconnected' && (e.port === input || e.port === output || e.port.id === output.id)) onLost(); };
  return {transport: window.CreatorHost ? 'native' : 'web-midi', send: b => output.send(b), close() { input.onmidimessage = null; access.onstatechange = null; }};
}

// ?demo=1: the App without a Box. It keeps the values, echoes them and makes the meters move.
function fakeApp(profile, deliver) {
  const cs = valued(profile), vals = new Map(cs.map(c => [c.cc, toCC(c, c.def ?? lo(c))]));
  const out = (cc, v) => queueMicrotask(() => deliver(Uint8Array.of(0xb0 | CH, cc, v)));
  let t = 0, burst = 0;
  const tick = setInterval(() => {
    t += 1; burst = Math.max(0, burst - 0.08);
    const play = 0.35 + 0.25 * Math.sin(t / 7) * Math.sin(t / 3.1) + burst;
    out(CC_METER_IN, Math.round(clamp(play, 0, 1) * 110));
    out(CC_METER_OUT, Math.round(clamp(play * 0.9 + 0.05, 0, 1) * 110));
  }, 90);
  return {transport: 'demo', close() { clearInterval(tick); }, send(b) {
    const [, cc, v] = b;
    if (cc === CC_QUERY) { for (const [k, x] of vals) out(k, x); return; }
    if (vals.has(cc)) { const c = cs.find(x => x.cc === cc); if (c.kind === 'readout') return; vals.set(cc, v); out(cc, v); }
    else if (v >= 64) burst = 0.6;
  }};
}
