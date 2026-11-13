/*
 * ResonaBridge: the Resona Box management protocol over Web MIDI SysEx.
 *
 * Plain-JS port of src/lib/resona-webserial.ts (framing, pack7, status parsing)
 * and of the preset-program client in RESONA_LAB core/lab-device/src/device_presets.rs.
 * Over USB MIDI the Box takes the same management frames the Web Serial installer
 * sends inside `\0RSM` CDC wrappers, but bare:
 *
 *   request  F0 7D 4E 43 70 pack7(ver=2, seq:u16, op:u16, len:u16, payload) F7
 *   reply    F0 7D 4E 43 71 pack7(ver=2, seq:u16, op:u16, status:u8, len:u16, payload) F7
 *
 * No UI here. app.js owns the page; this file owns bytes. FakeBox is an
 * in-memory device for `?demo=1`; it speaks the same frames so the demo
 * exercises the real encoder and decoder.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ bytes

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  class ResonaError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = "ResonaError";
      this.code = code;
      Object.assign(this, extra || {});
    }
  }

  function u16(b, o) {
    if (o < 0 || o + 2 > b.length) throw new ResonaError("device_error", "Truncated reply from the Resona Box.");
    return b[o] | (b[o + 1] << 8);
  }
  function u32(b, o) {
    if (o < 0 || o + 4 > b.length) throw new ResonaError("device_error", "Truncated reply from the Resona Box.");
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }
  const i32 = (b, o) => u32(b, o) | 0;
  const le16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  function f32(b, o) {
    u32(b, o);
    return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
  }
  function lef32(v) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, true);
    return [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)];
  }
  function concat(...parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function cString(b) {
    const end = b.indexOf(0);
    return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
  }
  const utf8 = (s) => new TextEncoder().encode(s);
  const toHex = (b) => Array.from(b || [], (x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ");

  function pack7(raw) {
    const out = [];
    for (let g = 0; g < raw.length; g += 7) {
      const group = raw.subarray(g, g + 7);
      let prefix = 0;
      group.forEach((b, bit) => { if (b & 0x80) prefix |= 1 << bit; });
      out.push(prefix);
      group.forEach((b) => out.push(b & 0x7f));
    }
    return Uint8Array.from(out);
  }
  function unpack7(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
      const prefix = data[i++];
      for (let bit = 0; bit < 7 && i < data.length; bit++) out.push(data[i++] | (((prefix >> bit) & 1) << 7));
    }
    return Uint8Array.from(out);
  }

  const HEAD = [0xf0, 0x7d, 0x4e, 0x43];
  const MAX_PAYLOAD = 768;

  function encodeRequest(seq, op, payload = new Uint8Array()) {
    if (payload.length > MAX_PAYLOAD) throw new RangeError("request payload too large");
    const raw = concat([2], le16(seq), le16(op), le16(payload.length), payload);
    return concat(HEAD, [0x70], pack7(raw), [0xf7]);
  }
  function encodeReply(seq, op, status, payload = new Uint8Array()) {
    const raw = concat([2], le16(seq), le16(op), [status], le16(payload.length), payload);
    return concat(HEAD, [0x71], pack7(raw), [0xf7]);
  }
  const isHead = (m, cmd) => m.length >= 7 && m[0] === 0xf0 && m[1] === 0x7d && m[2] === 0x4e && m[3] === 0x43 && m[4] === cmd;
  /** null for notifications (0x72) and anything that is not a version-2 reply. */
  function parseReply(m) {
    if (!isHead(m, 0x71) || m[m.length - 1] !== 0xf7) return null;
    const body = unpack7(m.subarray(5, m.length - 1));
    if (body.length < 8 || body[0] !== 2) return null;
    const len = u16(body, 6);
    if (body.length !== 8 + len) return null;
    return { seq: u16(body, 1), op: u16(body, 3), status: body[5], payload: body.slice(8, 8 + len) };
  }
  function parseRequest(m) {
    if (!isHead(m, 0x70) || m[m.length - 1] !== 0xf7) return null;
    const body = unpack7(m.subarray(5, m.length - 1));
    if (body.length < 7 || body[0] !== 2) return null;
    const len = u16(body, 5);
    if (body.length !== 7 + len) return null;
    return { seq: u16(body, 1), op: u16(body, 3), payload: body.slice(7) };
  }

  // ------------------------------------------------------------ protocol constants

  const Op = { IDENTIFY: 0x01, SETTINGS_SET: 0x66, LIVE_EDIT: 0x6d, PROGRAM: 0xa3 };
  /** Preset-program sub-operations (first payload byte of Op.PROGRAM). */
  const Sub = {
    STATUS: 0, LIST: 1, READ: 2, BEGIN: 3, CHUNK: 4, COMMIT: 5, ABORT: 6, ASSETS: 10, READ_ASSET: 11, PARAMS: 15, SET_PARAM: 16, ENABLE: 17, MAP: 18,
    SUBMIT: 19, JOB: 20, LIVE: 23, CPU: 24, MODELS: 25,
  };
  const Action = { LOAD: 1, PREVIEW: 2, SAVE: 3 };
  const Engine = { NONE: 0, GATE: 1, COMP: 2, RESONA: 3, NAM: 4, CAB: 5 };
  const ENGINE_NAMES = ["FX", "GATE", "COMP", "RESONA", "NAM", "CAB"];
  /** Model bank kind for an engine (op 25): amp profile, NAM, IR. */
  const MODEL_KIND = { 3: 10, 4: 11, 5: 12 };
  /** Box slot capacity per model kind (resonam_program.c model_capacity): sealed amp, NAM, IR. */
  const MODEL_CAPACITY = { 10: 0x3000 + 28 + 32, 11: 0x2000, 12: 0x1000 };
  const UPLOAD_CHUNK = 600;
  const ParamFlag = { STEPPED: 1, TOGGLE: 2, CHOICE: 4, LOG: 8 };
  const PRESET_COUNT = 50;
  const NONE32 = 0xffffffff;
  const STATUS_UNSUPPORTED = 0x7e;

  const PROGRAM_MESSAGES = {
    [-1]: "invalid argument", [-2]: "program or asset unavailable", [-3]: "not enough temporary RAM",
    [-4]: "storage read/write failed", [-8]: "shared storage is full or fragmented", [-9]: "Not enough CPU for this chain",
    [-11]: "program exceeds CPU admission budget", [-12]: "program cannot fit its RAM staging", [-15]: "the RPK has no code for this Box",
    [-16]: "device is busy", [-17]: "invalid record format or CRC", [-18]: "data changed; refresh before retrying",
    [-20]: "preset saved, but active selection was not updated", [-21]: "request cancelled by a newer selection",
    [-22]: "replacement failed and previous audio could not be restored; select a healthy preset",
    [-23]: "programme preparation exceeded its time budget",
    [-24]: "boot restore of this preset was interrupted twice and was skipped; select a preset",
    [-25]: "audio was not ready at boot; the preset was not restored",
  };
  const programMessage = (code) => PROGRAM_MESSAGES[code] || "program operation refused";

  // ------------------------------------------------------------ reply parsers

  /** Identify (op 0x01): mode, platform API, five length-prefixed strings, optional IV01 block. */
  function parseIdentity(d) {
    if (d.length < 2) throw new ResonaError("device_error", "Short identify reply.");
    let o = 2;
    const s = [];
    for (let i = 0; i < 5; i++) {
      if (o >= d.length) throw new ResonaError("device_error", "Short identify string.");
      const n = d[o];
      if (o + 1 + n > d.length) throw new ResonaError("device_error", "Truncated identify string.");
      s.push(new TextDecoder().decode(d.subarray(o + 1, o + 1 + n)));
      o += 1 + n;
    }
    return {
      mode: d[0] === 1 ? "app" : d[0] === 2 ? "safe" : "starting",
      platformApi: d[1], firmware: s[0], appId: s[1], appName: s[2], appVersion: s[3], safeReason: s[4],
    };
  }

  /** Program status (sub 0): 80 bytes `RPD2`, device_presets.rs status(). */
  function parseStatus(b) {
    if (b.length !== 80 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "RPD2" || b[4] !== 1 || b[5] !== 0 || b[6] !== 80 || b[7] !== 0) {
      throw new ResonaError("firmware_too_old", "This Box firmware does not offer preset programs. Update the Resona Box firmware.");
    }
    const active = u32(b, 32);
    if (active !== NONE32 && active >= PRESET_COUNT) throw new ResonaError("device_error", "Invalid active preset.");
    const enc = u32(b, 40);
    return {
      unit: u32(b, 8), generation: u32(b, 12), bankCrc32: u32(b, 16), capacity: u32(b, 20), free: u32(b, 24), files: u32(b, 28),
      activePreset: active === NONE32 ? null : active, parameterCount: u32(b, 36), encoderParameter: enc === NONE32 ? null : enc,
      enabled: u32(b, 44) !== 0, initialized: u32(b, 48) !== 0, programJobs: (u32(b, 76) & 1) !== 0,
    };
  }

  /** Live effect (sub 23): 24 bytes. */
  function parseLive(b, index) {
    if (b.length !== 24 || b[0] !== index || b[1] > 5 || b[2] > 1 || b[3] > 1) {
      throw new ResonaError("device_error", "Invalid live chain reply; this needs a matching Box OS.");
    }
    const m = u32(b, 4);
    return {
      index, engine: b[1], enabled: b[2] !== 0, fault: b[3] !== 0, model: m === NONE32 ? null : m,
      calls: u32(b, 8), lastTicks: u32(b, 12), peakTicks: u32(b, 16), reservedTicks: u32(b, 20),
    };
  }

  /** CPU (sub 24): 88 bytes, 22 words, word 0 = version 4. */
  function parseCpu(b) {
    if (b.length !== 88 || u32(b, 0) !== 4) throw new ResonaError("device_error", "This Box OS does not report DSP load.");
    const a = [];
    for (let i = 0; i < 22; i++) a.push(u32(b, i * 4));
    const period = a[2] || 1, budget = a[3] || 1;
    const pct = (n) => (100 * n) / period;
    return {
      blockFrames: a[1], periodTicks: a[2], budgetTicks: a[3],
      dsp: pct(a[4]), dspPeak: pct(a[5]), dspAverage: pct(a[6]),
      budgetUsage: (100 * a[6]) / budget, budgetPeak: (100 * a[5]) / budget,
      audio: pct(a[7]), audioPeak: pct(a[8]), callbacks: a[10], overruns: a[11],
      enabledMask: a[12], faultMask: a[13], overBudgetBlocks: a[15],
    };
  }

  /** Programme job (sub 20): 104 bytes (resona_program_job). */
  function parseJob(b) {
    if (b.length !== 104 || u32(b, 0) !== 1 || u32(b, 4) !== 104) throw new ResonaError("firmware_too_old", "Update the Resona Box firmware for programme jobs.");
    const slot = (o) => { const n = u32(b, o); return n < PRESET_COUNT ? n : null; };
    return {
      id: u32(b, 8), action: u32(b, 12), preset: slot(16), state: u32(b, 20), phase: u32(b, 24), done: u32(b, 28), total: u32(b, 32),
      result: i32(b, 36), bankCrc32: u32(b, 40), elapsedMs: u32(b, 44), queuedId: u32(b, 68), queuedPreset: slot(72), flags: u32(b, 76),
      activePreset: slot(80), committedPreset: slot(84), epoch: u32(b, 88), owner: u32(b, 92), boot: u32(b, 100),
    };
  }

  /** The chain headers of an `RPS3` record (resonam_program.c comment above `#define FX`). */
  function parseSnapshotChain(b) {
    if (b.length < 48 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "RPS3") throw new ResonaError("device_error", "Unsupported preset record.");
    const count = b[20], nameLen = u16(b, 28);
    if (count > 5 || nameLen > 16) throw new ResonaError("device_error", "Preset chain or name too long.");
    let at = 48 + ((nameLen + 3) & ~3);
    const fx = [];
    for (let i = 0; i < count; i++) {
      if (at + 12 > b.length) throw new ResonaError("device_error", "Truncated preset effect.");
      fx.push({ source: b[at], engine: b[at + 1], on: b[at + 2] !== 0, params: b[at + 3], model: u32(b, at + 4) });
      at += 12 + 4 * b[at + 3];
    }
    return { name: new TextDecoder().decode(b.subarray(48, 48 + nameLen)), flags: u32(b, 16), fx };
  }

  // ------------------------------------------------------------ client

  const FAST = [0, 1, 2, 10, 11, 15, 19, 20, 23, 24, 25];  // others (uploads, commit: a flash write) get 10 s
  /** Program sub-ops that change sound or storage. Refused in read-only mode. */
  const WRITES = new Set([3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 16, 17, 18, 19, 22]);

  /**
   * One management session. `send(bytes)` writes a SysEx message; feed every
   * incoming MIDI message to handleMessage(). Requests run one at a time.
   */
  class Client {
    constructor(send, { readOnly = false, onLog = null } = {}) {
      this.send = send;
      this.readOnly = readOnly;
      this.onLog = onLog;
      this.seq = 0;
      this.waiting = null;   // {seq, op, resolve, reject, timer}
      this.chain = Promise.resolve();
      this.partial = null;   // SysEx being assembled across messages
      this.closed = false;
    }

    close() {
      this.closed = true;
      if (this.waiting) {
        clearTimeout(this.waiting.timer);
        this.waiting.reject(new ResonaError("disconnected", "The Resona Box disconnected."));
        this.waiting = null;
      }
    }

    handleMessage(data) {
      const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
      if (!bytes.length) return;
      // Browsers hand over whole SysEx messages; reassemble anyway in case a driver splits one.
      let m = bytes;
      if (this.partial) {
        if (bytes[0] >= 0xf8) return;
        m = concat(this.partial, bytes);
        this.partial = null;
      }
      if (m[0] !== 0xf0) return;
      if (m[m.length - 1] !== 0xf7) {
        if (m.length < 4096) this.partial = m;
        return;
      }
      let reply = null;
      try { reply = parseReply(m); } catch { reply = null; }
      if (this.onLog) this.onLog("rx", m, reply);
      const w = this.waiting;
      if (!reply || !w || reply.seq !== w.seq || reply.op !== w.op) return;
      // BLE management replies: MORE/DONE wrap [total:u16, offset:u16, bytes].
      // Bound reassembly, verify overlaps and require complete coverage + final marker.
      try {
        if (reply.status === 0x10 || reply.status === 0x11) {
          const b = reply.payload;
          if (b.length < 4) throw new Error("Truncated BLE reply chunk");
          const total = u16(b, 0), offset = u16(b, 2), part = b.subarray(4);
          if (total > 65535 || offset + part.length > total || (!part.length && total)) throw new Error("Invalid BLE reply bounds");
          if (!w.assembly) w.assembly = { total, bytes: new Uint8Array(total), seen: new Uint8Array(total), count: 0, frames: 0, done: false };
          const a = w.assembly;
          if (a.total !== total || ++a.frames > 1024) throw new Error("Inconsistent BLE reply chunks");
          for (let i = 0; i < part.length; i++) {
            const at = offset + i;
            if (a.seen[at] && a.bytes[at] !== part[i]) throw new Error("Conflicting BLE reply chunk");
            if (!a.seen[at]) { a.seen[at] = 1; a.count++; }
            a.bytes[at] = part[i];
          }
          if (reply.status === 0x11) {
            if (offset + part.length !== total) throw new Error("Invalid BLE final chunk");
            a.done = true;
          }
          if (!a.done || a.count !== total) return;
          reply = { ...reply, status: 0, payload: a.bytes };
        } else if (w.assembly) throw new Error("Interrupted BLE reply");
      } catch (error) {
        this.waiting = null; clearTimeout(w.timer);
        w.reject(new ResonaError("device_error", error.message)); return;
      }
      this.waiting = null;
      clearTimeout(w.timer);
      w.resolve({ status: reply.status, payload: reply.payload });
    }

    /** One request; resolves {status, payload}. Serialized behind earlier requests. */
    request(op, payload = new Uint8Array(), timeoutMs = 3000) {
      const run = () => new Promise((resolve, reject) => {
        if (this.closed) return reject(new ResonaError("disconnected", "The Resona Box disconnected."));
        this.seq = (this.seq + 1) & 0xffff;
        const seq = this.seq;
        const frame = encodeRequest(seq, op, payload);
        const timer = setTimeout(() => {
          if (this.waiting && this.waiting.seq === seq) this.waiting = null;
          reject(new ResonaError("timeout", `No reply from the Resona Box (request 0x${op.toString(16)}).`));
        }, timeoutMs);
        this.waiting = { seq, op, resolve, reject, timer };
        if (this.onLog) this.onLog("tx", frame);
        try {
          Promise.resolve(this.send(frame)).catch(e => {
            if (this.waiting?.seq !== seq) return;
            clearTimeout(timer); this.waiting = null;
            reject(new ResonaError("disconnected", `Sending failed: ${e.message || e}`));
          });
        } catch (e) {
          clearTimeout(timer);
          this.waiting = null;
          reject(new ResonaError("disconnected", `Sending to the Resona Box failed: ${e.message || e}`));
        }
      });
      const p = this.chain.then(run, run);
      this.chain = p.catch(() => undefined);
      return p;
    }

    async program(sub, data = []) {
      if (this.readOnly && WRITES.has(sub)) throw new ResonaError("read_only", "Read-only mode: this change was not sent to the Box.");
      if (this.readOnly && sub === Sub.LIVE && data[1] !== 255) throw new ResonaError("read_only", "Read-only mode: this change was not sent to the Box.");
      const r = await this.request(Op.PROGRAM, concat([sub], data), FAST.includes(sub) ? 3000 : 10000);
      if (r.status !== 0) {
        if (r.status === STATUS_UNSUPPORTED) throw new ResonaError("firmware_too_old", "Update the Resona Box firmware for the preset-program backend.");
        const code = r.payload.length === 4 ? i32(r.payload, 0) : 0;
        throw new ResonaError("device_error", `${programMessage(code)} (device code ${code}, status 0x${r.status.toString(16).padStart(2, "0")})`, { deviceCode: code, status: r.status });
      }
      return r.payload;
    }

    async identify() {
      const r = await this.request(Op.IDENTIFY, new Uint8Array(), 1500);
      if (r.status !== 0) throw new ResonaError("device_error", `Identify failed with status ${r.status}.`);
      return parseIdentity(r.payload);
    }

    async status() { return parseStatus(await this.program(Sub.STATUS)); }

    /** Sub 1, pages of 16: [crc, start, count] + 32-byte rows (slot, flags, rpk id, fx count, crc, 0, params, name[16]). */
    async list(st) {
      if (!st.initialized) return Array.from({ length: PRESET_COUNT }, (_, slot) => ({ slot, name: "", used: false, enabled: false, effects: 0, params: 0 }));
      const out = [];
      for (let start = 0; start < PRESET_COUNT; start += 16) {
        const count = Math.min(PRESET_COUNT - start, 16);
        const b = await this.program(Sub.LIST, [...le32(start), ...le32(count)]);
        if (b.length !== 12 + count * 32 || u32(b, 0) !== st.bankCrc32 || u32(b, 4) !== start || u32(b, 8) !== count) {
          throw new ResonaError("changed", "The preset bank changed while it was being read. Try again.");
        }
        for (let i = 0; i < count; i++) {
          const r = b.subarray(12 + i * 32, 44 + i * 32);
          out.push({ slot: r[0], used: (r[1] & 1) !== 0, enabled: (r[1] & 2) !== 0, effects: r[3], params: u32(r, 12), name: cString(r.subarray(16, 32)) });
        }
      }
      return out;
    }

    /** Sub 2: one stored preset record, in chunks: [slot u32, offset u32, expected bank crc u32]. */
    async readPreset(slot, expected) {
      const parts = [];
      let have = 0;
      for (let guard = 0; guard < 600; guard++) {
        const b = await this.program(Sub.READ, [...le32(slot), ...le32(have), ...le32(expected)]);
        if (b.length < 12 || u32(b, 0) !== expected || u32(b, 8) !== have) throw new ResonaError("changed", "The preset changed while it was being read.");
        const total = u32(b, 4);
        parts.push(b.subarray(12));
        have += b.length - 12;
        if (have === total) return concat(...parts);
        if (have > total || b.length === 12) throw new ResonaError("device_error", "Invalid preset read.");
      }
      throw new ResonaError("device_error", "Preset read made no progress.");
    }

    /** Sub 23 [index, model or 255]: query (255) or select a built-in model 0..29. */
    async live(index, model = null) {
      return parseLive(await this.program(Sub.LIVE, [index, model == null ? 255 : model]), index);
    }

    /** The live chain: indices 0..4 until the Box refuses one (shorter chains). */
    async liveChain() {
      const out = [];
      for (let i = 0; i < 5; i++) {
        try { out.push(await this.live(i)); } catch (e) {
          if (e.code === "device_error" && e.status === 7 && out.length) break;
          if (e.code === "device_error" && e.status === 7) break;
          throw e;
        }
      }
      return out;
    }

    /** Live-edit command 0x6D, SET_ENABLED: [3, effect, on]; the Box echoes the three bytes. */
    async liveEnable(index, enabled) {
      if (this.readOnly) throw new ResonaError("read_only", "Read-only mode: this change was not sent to the Box.");
      const body = [3, index, enabled ? 1 : 0];
      const r = await this.request(Op.LIVE_EDIT, Uint8Array.from(body), 3000);
      if (r.status !== 0 || r.payload.length !== 3 || r.payload[0] !== 3 || r.payload[1] !== index || r.payload[2] !== body[2]) {
        throw new ResonaError("device_error", `The Box refused to switch this block (status 0x${r.status.toString(16).padStart(2, "0")}). Check DSP headroom.`);
      }
      const actual = await this.live(index);
      if (actual.enabled !== enabled || (enabled && actual.fault)) throw new ResonaError("device_error", "The block did not reach the requested state.");
      return actual;
    }

    /** Sub 25 [kind, start, 16]: [total, start, count] + 28-byte rows (used, sealed, 0, 0, length, crc, name[16]). */
    async modelSlots(kind) {
      const out = [];
      for (let guard = 0; guard < 4; guard++) {
        const b = await this.program(Sub.MODELS, [kind, out.length, 16]);
        if (b.length < 12 || u32(b, 4) !== out.length) throw new ResonaError("device_error", "Invalid model slot page.");
        const total = u32(b, 0), count = u32(b, 8);
        if (total > 30 || count === 0 || b.length !== 12 + count * 28) throw new ResonaError("device_error", "Invalid model slot page.");
        for (let i = 0; i < count; i++) {
          const r = b.subarray(12 + i * 28, 40 + i * 28);
          out.push({ slot: out.length, used: r[0] !== 0, sealed: r[1] !== 0, bytes: u32(r, 4), crc32: u32(r, 8), name: cString(r.subarray(12, 28)) });
        }
        if (out.length >= total) return out;
      }
      return out;
    }

    /**
     * Upload one model payload into slot 0..29 of its bank (device_presets.rs upload + upload_model):
     * sub 3 begin [kind, slot, 0, 0, size, crc, expected=0, name[24]] -> token; sub 4 chunks of 600
     * [token, offset, data] -> received; sub 5 commit [token] -> [slot, kind, 0, 0, length, crc];
     * sub 6 abort [token] on any failure.
     */
    async uploadModel(kind, slot, name, bytes, onProgress) {
      if (kind < 10 || kind > 12 || slot >= 30) throw new ResonaError("device_error", "Model kind must be Resona, NAM or IR and its slot 1..30.");
      if (!bytes.length || bytes.length > MODEL_CAPACITY[kind]) throw new ResonaError("device_error", "This model is too large for its Box slot.");
      const field = new Uint8Array(24);
      field.set(utf8(name).subarray(0, 23));
      const crc = crc32(bytes);
      const token = await this.program(Sub.BEGIN, concat([kind, slot, 0, 0], le32(bytes.length), le32(crc), le32(0), field));
      if (token.length !== 4) throw new ResonaError("device_error", "Invalid upload token.");
      try {
        for (let off = 0; off < bytes.length; off += UPLOAD_CHUNK) {
          const chunk = bytes.subarray(off, off + UPLOAD_CHUNK);
          const b = await this.program(Sub.CHUNK, concat(token, le32(off), chunk));
          if (b.length !== 4 || u32(b, 0) !== off + chunk.length) throw new ResonaError("device_error", "Upload progress mismatch.");
          if (onProgress) onProgress((off + chunk.length) / bytes.length);
        }
        const r = await this.program(Sub.COMMIT, token);
        if (r.length !== 12 || r[0] !== slot || r[1] !== kind || u32(r, 4) !== bytes.length || u32(r, 8) !== crc) {
          throw new ResonaError("device_error", "Invalid model upload response.");
        }
        return r;
      } catch (e) {
        await this.program(Sub.ABORT, token).catch(() => undefined);
        throw e;
      }
    }

    /** Sub 10 [start, count<=16]: the storage catalogue, 36-byte rows (id, kind, system, 0, length, crc, name[24]). */
    async poolFiles() {
      const out = [];
      for (let start = 0, guard = 0; guard < 64; guard++) {
        const b = await this.program(Sub.ASSETS, [...le32(start), ...le32(16)]);
        if (b.length < 12 || u32(b, 4) !== start) throw new ResonaError("device_error", "Invalid storage page.");
        const total = u32(b, 0), count = u32(b, 8);
        if (count > 16 || b.length !== 12 + count * 36) throw new ResonaError("device_error", "Invalid storage catalogue.");
        for (let i = 0; i < count; i++) {
          const r = b.subarray(12 + i * 36, 48 + i * 36);
          out.push({ id: r[0], kind: r[1], system: r[2] !== 0, bytes: u32(r, 4), crc32: u32(r, 8), name: cString(r.subarray(12, 36)) });
        }
        start += count;
        if (start >= total || count === 0) return out;
      }
      return out;
    }

    /** Sub 11 [id, offset u32, crc u32] -> [crc, size, offset, data]; the whole file's CRC is checked. */
    async readAsset(id, crc, onProgress) {
      const parts = [];
      let have = 0;
      for (let guard = 0; guard < 2000; guard++) {
        const b = await this.program(Sub.READ_ASSET, [id, ...le32(have), ...le32(crc)]);
        if (b.length < 12 || u32(b, 0) !== crc || u32(b, 8) !== have) throw new ResonaError("device_error", "The file changed while it was being read.");
        const total = u32(b, 4);
        parts.push(b.subarray(12));
        have += b.length - 12;
        if (onProgress && total) onProgress(have / total);
        if (have === total) {
          const all = concat(...parts);
          if (crc32(all) !== crc) throw new ResonaError("device_error", "The file read back with a wrong CRC.");
          return all;
        }
        if (have > total || b.length === 12) throw new ResonaError("device_error", "Invalid file read.");
      }
      throw new ResonaError("device_error", "File read made no progress.");
    }

    /** The stored bytes of one model slot (device_presets.rs read_model): pool file "EAD 07" / "NAM 07" / "IR 07". */
    async readModel(kind, slot, onProgress) {
      const bank = kind === 10 ? "EAD" : kind === 11 ? "NAM" : "IR";
      const want = `${bank} ${String(slot).padStart(2, "0")}`;
      const file = (await this.poolFiles()).find((f) => f.kind === kind && f.name === want);
      if (!file) throw new ResonaError("empty", `Slot ${slot + 1} is empty.`);
      try {
        return await this.readAsset(file.id, file.crc32, onProgress);
      } catch (e) {
        // The firmware answers STATE (-2) when the stored amp profile isn't a SAPF envelope.
        if (kind === 10 && e.deviceCode === -2) throw new ResonaError("older_format", "This model can't be exported.");
        throw e;
      }
    }

    /** Sub 15 in pages of 12: [total, start, count] + 52-byte rows. */
    async parameters() {
      const out = [];
      let total = Infinity;
      for (let start = 0; start < total && start < 1024;) {
        const b = await this.program(Sub.PARAMS, [...le32(start), ...le32(12)]);
        if (b.length < 12 || u32(b, 4) !== start) throw new ResonaError("device_error", "Invalid parameter page.");
        total = u32(b, 0);
        const n = u32(b, 8);
        if (n > 12 || b.length !== 12 + n * 52) throw new ResonaError("device_error", "Invalid parameter page length.");
        for (let i = 0; i < n; i++) {
          const r = b.subarray(12 + i * 52, 64 + i * 52);
          out.push({ id: u32(r, 0), name: cString(r.subarray(4, 20)), unit: cString(r.subarray(20, 28)),
            min: f32(r, 28), max: f32(r, 32), def: f32(r, 36), flags: u32(r, 40), step: f32(r, 44), value: f32(r, 48) });
        }
        if (!n) break;
        start += n;
      }
      return out;
    }

    /** Sub 16 [id u32, value f32] -> applied f32. Live only; nothing is stored. */
    async setParameter(id, value) {
      if (!Number.isFinite(value)) throw new ResonaError("device_error", "Parameter value must be finite.");
      const b = await this.program(Sub.SET_PARAM, [...le32(id), ...lef32(value)]);
      if (b.length !== 4) throw new ResonaError("device_error", "Invalid parameter result.");
      return f32(b, 0);
    }

    // Existing firmware accepts an empty settings mask: no setters or flash
    // writes run, but its normal App-changed notification redraws the screen.
    async refreshScreen() {
      if (this.readOnly) throw new ResonaError("read_only", "Read-only mode: screen refresh was not sent to the Box.");
      const r = await this.request(Op.SETTINGS_SET, new Uint8Array([0, 0]), 3000);
      if (r.status !== 0 || r.payload.length !== 15 || r.payload[0] !== 2) {
        throw new ResonaError("device_error", "The Box did not acknowledge the screen refresh.");
      }
    }

    async cpu() { return parseCpu(await this.program(Sub.CPU)); }
    async job() { return parseJob(await this.program(Sub.JOB)); }

    /** Sub 19 [action, slot, 0, 0, expected u32, name...]: returns the job id. */
    async submit(action, slot, name, expected) {
      const n = name ? utf8(name) : new Uint8Array();
      if (![1, 2, 3, 5].includes(action) || slot >= PRESET_COUNT || n.length > 16) throw new ResonaError("device_error", "Invalid programme request.");
      const b = await this.program(Sub.SUBMIT, [action, slot, 0, 0, ...le32(expected >>> 0), ...n]);
      if (b.length !== 4 || u32(b, 0) === 0) throw new ResonaError("device_error", "Invalid programme job response.");
      return u32(b, 0);
    }

    /** Polls sub 20 until job `id` completes (device_presets.rs wait()). */
    async wait(id, onProgress, deadlineMs = 180000) {
      const end = Date.now() + deadlineMs;
      let boot = null;
      for (;;) {
        const j = await this.job();
        if (boot === null) boot = j.boot;
        else if (boot !== j.boot) throw new ResonaError("device_error", "The Box restarted while the preset was loading.");
        if (onProgress) onProgress(j);
        if (j.id === id && j.state >= 5) {
          if (j.result < 0) throw new ResonaError("device_error", `${programMessage(j.result)} (result ${j.result})`, { deviceCode: j.result });
          if (j.state !== 5) throw new ResonaError("device_error", "The request was cancelled.");
          return j;
        }
        if (j.id > id && j.queuedId !== id) throw new ResonaError("superseded", "A newer selection replaced this request.");
        if (Date.now() > end) throw new ResonaError("timeout", "The Box is still working on this request.");
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    async load(slot, onProgress) { return this.wait(await this.submit(Action.LOAD, slot, null, 0), onProgress); }
    async captureSave(slot, name, expected, onProgress) { return this.wait(await this.submit(Action.SAVE, slot, name, expected), onProgress); }
  }

  // ------------------------------------------------------------ demo device

  /**
   * A Resona Box in memory, for ?demo=1. handle(requestBytes) returns reply bytes
   * (or null), shaped like resonam_program.c `serve` and resonam_live_edit.c.
   */
  class FakeBox {
    constructor() {
      const P = (name, unit, min, max, def, step, flags = 0) => ({ name, unit, min, max, def, step, flags });
      this.engines = {
        1: [P("Threshold", "dB", -90, 0, -60, 1), P("Release", "ms", 5, 500, 80, 1), P("Auto", "", 0, 1, 0, 1, 2)],
        2: [P("Sustain", "dB", 0, 30, 12, 0.5), P("Attack", "ms", 1, 100, 10, 1), P("Level", "dB", -12, 12, 0, 0.5), P("Mix", "%", 0, 100, 100, 1)],
        3: [P("Gain", "", 0, 10, 5, 0.1), P("Bass", "", 0, 10, 5, 0.1), P("Middle", "", 0, 10, 5, 0.1), P("Treble", "", 0, 10, 5, 0.1), P("Presence", "", 0, 10, 5, 0.1), P("Volume", "dB", -24, 12, 0, 0.5)],
        4: [P("Input", "dB", -24, 24, 0, 0.5), P("Output", "dB", -24, 24, 0, 0.5), P("Tone", "Hz", 200, 8000, 2500, 10, 8)],
        5: [P("Low Cut", "Hz", 20, 400, 80, 1, 8), P("High Cut", "Hz", 2000, 20000, 9000, 10, 8), P("Level", "dB", -24, 12, 0, 0.5), P("Mic", "", 0, 3, 0, 1, 4)],
      };
      const names = ["GLASS DRIVE", "CLEAN SKY", "FAT CRUNCH", "LEAD 800", "AMBIENT", "BLUES BOX", "DJENT", "JAZZ", "FUNK", "METAL ZONE"];
      this.models = {
        10: ["Glass Drive", "Clean Sky", "British 800", "Blues Combo", "Plexi 68", "Rect Hi", "Jazz 120", "Tweed Lux"],
        11: ["JCM Edge", "5150 Ch3", "Dumble OD", "AC Top", "Recto Mod"],
        12: ["4x12 V30 57", "2x12 Blue", "1x12 Jensen", "4x12 G12M", "2x10 Tweed", "OD 4x12 121"],
      };
      // Model slots with stored payloads: kind -> 30 x ({ name, bytes } | null), plus pool ids.
      this.store = {};
      this.poolId = 40;
      for (const kind of [10, 11, 12]) {
        this.store[kind] = Array.from({ length: 30 }, (_, i) => {
          const name = this.models[kind][i];
          if (!name) return null;
          return { name, bytes: this.fakePayload(kind, i, kind === 10 && i === 6), id: ++this.poolId };
        });
      }
      this.upload = null;
      this.slots = Array.from({ length: 50 }, (_, i) => {
        const used = i < names.length || i === 14 || i === 22;
        return { used, name: used ? names[i] || `USER ${i + 1}` : "", chain: used ? this.makeChain(i) : null };
      });
      this.generation = 7;
      this.unit = 0x5e50b0c5;
      this.active = 0;
      this.live = this.slots[0].chain.map((e) => ({ ...e, values: e.values.slice() }));
      this.jobs = { id: 100, current: null };
      this.mapped = null;
      this.boot = 3;
      this.ticks = 0;
    }

    /** A plausible payload: a SAPF envelope (or a raw pre-1.02 profile), an NA2L, or 1024 IR taps. */
    fakePayload(kind, seed, raw) {
      if (kind === 10) {
        const n = 2400 + seed * 16;
        if (raw) return concat(utf8("DDPB"), new Uint8Array(n).map((_, i) => (i * 7 + seed) & 255));
        return concat(utf8("SAPF"), [1, 0, 0, 0], new Uint8Array(16).fill(seed), le32(n), new Uint8Array(n).map((_, i) => (i * 13 + seed) & 255), new Uint8Array(32).fill(0xa5));
      }
      if (kind === 11) {
        const w = new Uint8Array(1871 * 4);
        const dv = new DataView(w.buffer);
        for (let i = 0; i < 1871; i++) dv.setFloat32(i * 4, Math.sin(i * 0.37 + seed) * 0.1, true);
        return concat(utf8("NA2L"), le16(1), le16(32), le32(48000), le32(1871), le32(7484), le32(crc32(w)), le32(1), le32(0), w);
      }
      const t = new Uint8Array(4096);
      const dv = new DataView(t.buffer);
      for (let i = 0; i < 1024; i++) dv.setFloat32(i * 4, Math.exp(-i / (60 + seed * 4)) * Math.cos(i * (0.2 + seed * 0.01)), true);
      return t;
    }

    makeChain(seed) {
      return [1, 2, 3, 4, 5].map((engine, i) => ({
        engine, on: engine === 3 || engine === 5 || (seed + i) % 3 === 0,
        model: engine >= 3 ? (seed * 3 + engine) % this.models[{ 3: 10, 4: 11, 5: 12 }[engine]].length : NONE32,
        values: this.engines[engine].map((p) => p.def),
      }));
    }

    bankCrc() {
      return crc32(utf8(JSON.stringify(this.slots.map((s) => [s.used, s.name, s.chain])) + this.generation));
    }

    flat() {
      const out = [];
      this.live.forEach((e, ei) => this.engines[e.engine].forEach((p, pi) => out.push({ e, ei, p, pi })));
      return out;
    }

    record(slot) {
      const s = this.slots[slot];
      const name = utf8(s.name);
      const chain = s.chain || [];
      const head = new Uint8Array(48);
      head.set(utf8("RPS3"), 0);
      head[4] = 1; head[6] = 48;
      head.set(le32(s.used ? 3 : 0), 16);
      head[20] = chain.length; head[21] = head[22] = 0xff;
      head.set(le16(name.length), 28);
      const pad = new Uint8Array((name.length + 3) & ~3);
      pad.set(name);
      const fx = chain.map((e) => concat([1, e.engine, e.on ? 1 : 0, e.values.length], le32(e.model), le32(0), ...e.values.map(lef32)));
      const all = concat(head, pad, ...fx);
      all.set(le32(all.length), 8);
      return all;
    }

    reply(seq, op, status, payload) { return encodeReply(seq, op, status, Uint8Array.from(payload || [])); }

    handle(bytes) {
      const req = parseRequest(bytes);
      if (!req) return null;
      const { seq, op, payload } = req;
      if (op === Op.IDENTIFY) {
        const s = (t) => { const b = utf8(t); return [b.length, ...b]; };
        return this.reply(seq, op, 0, [1, 14, ...s("1.04 (demo)"), ...s("com.livtra.resona"), ...s("Resona"), ...s("1.4.0"), ...s("")]);
      }
      if (op === Op.SETTINGS_SET) {
        if (payload.length !== 2 || payload[0] !== 0 || payload[1] !== 0) return this.reply(seq, op, 1, []);
        return this.reply(seq, op, 0, [2, ...new Array(14).fill(0)]);
      }
      if (op === Op.LIVE_EDIT) {
        if (payload.length !== 3 || payload[0] !== 3) return this.reply(seq, op, 1, []);
        const e = this.live[payload[1]];
        if (!e) return this.reply(seq, op, 3, []);
        e.on = payload[2] !== 0;
        return this.reply(seq, op, 0, payload);
      }
      if (op !== Op.PROGRAM || !payload.length) return this.reply(seq, op, 0x7e, []);
      const sub = payload[0], d = payload.subarray(1);
      const fail = (code) => this.reply(seq, op, 7, le32(code >>> 0));
      const ok = (p) => this.reply(seq, op, 0, p);
      switch (sub) {
        case 0: {
          const b = new Uint8Array(80);
          b.set(utf8("RPD2")); b[4] = 1; b[6] = 80;
          b.set(le32(this.unit), 8); b.set(le32(this.generation), 12); b.set(le32(this.bankCrc()), 16);
          b.set(le32(8 << 20), 20); b.set(le32(5 << 20), 24); b.set(le32(31), 28);
          b.set(le32(this.active == null ? NONE32 : this.active), 32); b.set(le32(this.flat().length), 36);
          b.set(le32(this.mapped == null ? NONE32 : this.mapped), 40); b.set(le32(1), 44); b.set(le32(1), 48);
          b.set(le32(1), 76);
          return ok(b);
        }
        case 1: {
          if (d.length !== 8) return fail(-1);
          const start = u32(d, 0); let count = u32(d, 4);
          if (start >= 50 || !count || count > 16) return fail(-1);
          count = Math.min(count, 50 - start);
          const rows = [];
          for (let i = 0; i < count; i++) {
            const s = this.slots[start + i];
            const r = new Uint8Array(32);
            r[0] = start + i; r[1] = s.used ? 3 : 0; r[3] = s.chain ? s.chain.length : 0;
            r.set(le32(s.chain ? s.chain.reduce((n, e) => n + e.values.length, 0) : 0), 12);
            r.set(utf8(s.name).subarray(0, 16), 16);
            rows.push(r);
          }
          return ok(concat(le32(this.bankCrc()), le32(start), le32(count), ...rows));
        }
        case 2: {
          if (d.length !== 12) return fail(-1);
          const slot = u32(d, 0), off = u32(d, 4);
          if (slot >= 50 || u32(d, 8) !== this.bankCrc()) return fail(-18);
          const rec = this.record(slot);
          if (off > rec.length) return fail(-1);
          return ok(concat(le32(this.bankCrc()), le32(rec.length), le32(off), rec.subarray(off, off + 600)));
        }
        case 15: {
          const all = this.flat();
          const start = u32(d, 0); let count = u32(d, 4);
          if (start > all.length || !count || count > 12) return fail(-1);
          count = Math.min(count, all.length - start);
          const rows = [];
          for (let i = 0; i < count; i++) {
            const { e, p, pi } = all[start + i];
            const r = new Uint8Array(52);
            r.set(le32(start + i), 0); r.set(utf8(p.name).subarray(0, 15), 4); r.set(utf8(p.unit).subarray(0, 7), 20);
            r.set(lef32(p.min), 28); r.set(lef32(p.max), 32); r.set(lef32(p.def), 36); r.set(le32(p.flags), 40);
            r.set(lef32(p.step), 44); r.set(lef32(e.values[pi]), 48);
            rows.push(r);
          }
          return ok(concat(le32(all.length), le32(start), le32(count), ...rows));
        }
        case 16: {
          if (d.length !== 8) return fail(-1);
          const it = this.flat()[u32(d, 0)];
          const v = f32(d, 4);
          if (!it || !(v >= it.p.min && v <= it.p.max)) return fail(-1);
          const q = Math.fround(it.p.step > 0 && it.p.flags & 1 ? it.p.min + Math.round((v - it.p.min) / it.p.step) * it.p.step : v);
          it.e.values[it.pi] = q;
          return ok(lef32(q));
        }
        case 19: {
          if (d.length < 8 || d[2] || d[3]) return fail(-1);
          const action = d[0], slot = d[1], expected = u32(d, 4);
          const name = new TextDecoder().decode(d.subarray(8));
          if (![1, 3].includes(action) || slot >= 50) return fail(-1);
          if (expected && expected !== this.bankCrc()) return fail(-18);
          const id = ++this.jobs.id;
          this.jobs.current = { id, action, slot, name, state: 2, started: Date.now(), result: 0 };
          setTimeout(() => this.finish(id), action === 1 ? 420 : 700);
          return ok(le32(id));
        }
        case 20: {
          const j = this.jobs.current || { id: 0, action: 0, slot: NONE32, state: 0, result: 0, started: Date.now() };
          const b = new Uint8Array(104);
          b.set(le32(1), 0); b.set(le32(104), 4); b.set(le32(j.id), 8); b.set(le32(j.action), 12); b.set(le32(j.slot), 16);
          b.set(le32(j.state), 20); b.set(le32(j.state >= 5 ? 4 : 2), 28); b.set(le32(4), 32); b.set(le32(j.result >>> 0), 36);
          b.set(le32(this.bankCrc()), 40); b.set(le32(Date.now() - j.started), 44);
          b.set(le32(this.active == null ? NONE32 : this.active), 80); b.set(le32(this.active == null ? NONE32 : this.active), 84);
          b.set(le32(this.boot), 100);
          return ok(b);
        }
        case 23: {
          if (d.length !== 2 || d[0] >= this.live.length) return fail(-1);
          const e = this.live[d[0]];
          if (d[1] !== 255) {
            const kind = { 3: 10, 4: 11, 5: 12 }[e.engine];
            if (!kind || d[1] >= 30 || !this.store[kind][d[1]]) return fail(-1);
            e.model = d[1];
          }
          const r = new Uint8Array(24);
          r[0] = d[0]; r[1] = e.engine; r[2] = e.on ? 1 : 0; r[3] = 0;
          r.set(le32(e.engine >= 3 ? e.model : NONE32), 4); r.set(le32(++this.ticks * 375), 8);
          r.set(le32(e.on ? 900 + e.engine * 300 : 0), 12); r.set(le32(e.on ? 1400 + e.engine * 300 : 0), 16);
          return ok(r);
        }
        case 24: {
          const w = new Array(22).fill(0);
          const load = this.live.reduce((n, e) => n + (e.on ? [0, 2, 3, 11, 15, 5][e.engine] : 0), 4);
          const jitter = Math.sin(Date.now() / 900) * 2;
          const period = 60000;
          w[0] = 4; w[1] = 128; w[2] = period; w[3] = period * 0.8;
          w[4] = Math.round(period * (load + jitter) / 100); w[5] = Math.round(period * (load + 6) / 100); w[6] = Math.round(period * load / 100);
          w[7] = w[4] + 3000; w[8] = w[5] + 3600; w[9] = 3000; w[10] = (this.ticks += 375);
          this.live.forEach((e, i) => { if (e.on) w[12] |= 1 << i; });
          return ok(concat(...w.map((x) => le32(x >>> 0))));
        }
        case 25: {
          if (d.length !== 3 || d[0] < 10 || d[0] > 12) return fail(-1);
          const kind = d[0], start = d[1];
          const total = kind === 12 ? 30 : kind === 11 ? 30 : 30;
          if (start >= total || !d[2] || d[2] > 16) return fail(-1);
          const count = Math.min(d[2], total - start);
          const rows = [];
          for (let i = 0; i < count; i++) {
            const m = this.store[kind][start + i];
            const r = new Uint8Array(28);
            if (m) { r[0] = 1; r[1] = kind === 10 && m.bytes[0] === 0x53 ? 1 : 0; r.set(le32(m.bytes.length), 4); r.set(le32(crc32(m.bytes)), 8); r.set(utf8(m.name).subarray(0, 15), 12); }
            rows.push(r);
          }
          return ok(concat(le32(total), le32(start), le32(count), ...rows));
        }
        case 3: {
          if (d.length !== 40) return fail(-1);
          const kind = d[0], slot = d[1], size = u32(d, 4);
          const cap = MODEL_CAPACITY[kind];
          if (!cap || d[2] || d[3] || !size || slot >= 30 || size > cap) return fail(-1);
          this.upload = { token: ++this.ticks, kind, slot, size, crc: u32(d, 8), name: new TextDecoder().decode(d.subarray(16, 40)).replace(/\0.*$/s, "").slice(0, 15), parts: [], received: 0 };
          return ok(le32(this.upload.token));
        }
        case 4: {
          const up = this.upload;
          if (d.length < 8 || !up || u32(d, 0) !== up.token || u32(d, 4) !== up.received || d.length - 8 > up.size - up.received) return fail(-1);
          up.parts.push(d.slice(8));
          up.received += d.length - 8;
          return ok(le32(up.received));
        }
        case 5: {
          const up = this.upload;
          if (d.length !== 4 || !up || u32(d, 0) !== up.token) return fail(-1);
          this.upload = null;
          const bytes = concat(...up.parts);
          if (up.received !== up.size || crc32(bytes) !== up.crc) return fail(-17);
          if (up.kind === 10 && String.fromCharCode(...bytes.subarray(0, 4)) !== "SAPF") return fail(-4);
          this.store[up.kind][up.slot] = { name: up.name, bytes, id: ++this.poolId };
          return ok(concat([up.slot, up.kind, 0, 0], le32(up.size), le32(up.crc)));
        }
        case 6: {
          if (d.length !== 4 || !this.upload || u32(d, 0) !== this.upload.token) return fail(-1);
          this.upload = null;
          return ok([]);
        }
        case 10: {
          if (d.length !== 8) return fail(-1);
          const files = [];
          for (const kind of [10, 11, 12]) this.store[kind].forEach((m, i) => {
            if (m) files.push({ id: m.id, kind, bytes: m.bytes, name: `${kind === 10 ? "EAD" : kind === 11 ? "NAM" : "IR"} ${String(i).padStart(2, "0")}` });
          });
          const start = u32(d, 0); let count = u32(d, 4);
          if (start > files.length || !count || count > 16) return fail(-1);
          count = Math.min(count, files.length - start);
          const rows = files.slice(start, start + count).map((f) => {
            const r = new Uint8Array(36);
            r[0] = f.id; r[1] = f.kind; r[2] = 1;
            r.set(le32(f.bytes.length), 4); r.set(le32(crc32(f.bytes)), 8); r.set(utf8(f.name), 12);
            return r;
          });
          return ok(concat(le32(files.length), le32(start), le32(count), ...rows));
        }
        case 11: {
          if (d.length !== 9) return fail(-1);
          let m = null;
          for (const kind of [10, 11, 12]) for (const x of this.store[kind]) if (x && x.id === d[0]) m = { ...x, kind };
          const off = u32(d, 1), crc = u32(d, 5);
          if (!m || crc32(m.bytes) !== crc || off > m.bytes.length) return fail(-18);
          if (m.kind === 10 && m.bytes[0] !== 0x53) return fail(-2);
          return ok(concat(le32(crc), le32(m.bytes.length), le32(off), m.bytes.subarray(off, off + 600)));
        }
        default:
          return fail(-1);
      }
    }

    finish(id) {
      const j = this.jobs.current;
      if (!j || j.id !== id) return;
      if (j.action === 1) {
        const s = this.slots[j.slot];
        this.active = j.slot;
        const chain = s.chain || [];
        this.live = chain.map((e) => ({ ...e, values: e.values.slice() }));
      } else if (j.action === 3) {
        const s = this.slots[j.slot];
        s.used = true;
        if (j.name) s.name = j.name;
        s.chain = this.live.map((e) => ({ ...e, values: e.values.slice() }));
        this.generation++;
        this.active = j.slot;
      }
      j.state = 5;
    }
  }

  root.ResonaBridge = {
    ResonaError, Client, FakeBox,
    pack7, unpack7, crc32, encodeRequest, encodeReply, parseReply, parseRequest,
    parseIdentity, parseStatus, parseLive, parseCpu, parseJob, parseSnapshotChain, programMessage, toHex,
    Op, Sub, Action, Engine, ENGINE_NAMES, MODEL_KIND, MODEL_CAPACITY, ParamFlag, PRESET_COUNT,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
