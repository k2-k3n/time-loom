/* Creator controller SDK v1. Host provides only bounded MIDI and connection state. */
(() => {
  'use strict';
  if (!window.CreatorHost) return; // Desktop browser uses Web MIDI or ?demo=1.
  let sequence = 0, connected = false;
  const pending = new Map(), listeners = new Set();
  function call(method, data) {
    if (pending.size >= 64) return Promise.reject(new Error('Controller queue full'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native MIDI timed out')); }, 12000);
      pending.set(id, { resolve, reject, timer });
      CreatorHost.postMessage(JSON.stringify({ id, method, data }));
    });
  }
  const input = { id: 'native-in', name: 'Resona Box BT', manufacturer: 'LIVTRA', type: 'input', state: 'connected', onmidimessage: null };
  const output = { id: 'native-out', name: 'Resona Box BT', manufacturer: 'LIVTRA', type: 'output', state: 'connected', send(data) {
    if (!connected) throw new Error('Connect a Box using the BT button first.');
    return call('send', Array.from(data));
  }};
  const access = { inputs: new Map([['native-in', input]]), outputs: new Map([['native-out', output]]), onstatechange: null };
  window.__creatorReceive = event => {
    if (event.id) {
      const p = pending.get(event.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(event.id);
      event.error ? p.reject(new Error(event.error)) : p.resolve(event.result);
    } else if (event.type === 'midi') {
      const data = Uint8Array.from(event.data);
      input.onmidimessage?.({ data }); listeners.forEach(fn => fn(data));
    } else if (event.type === 'state') {
      connected = !!event.connected;
      input.state = output.state = connected ? 'connected' : 'disconnected';
      access.onstatechange?.({ port: output });
      window.dispatchEvent(new CustomEvent('creatorstatechange', {detail:{connected}}));
      if (!connected) {
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
        pending.clear();
      }
    }
  };
  navigator.requestMIDIAccess = async () => {
    connected = !!(await call('status')).connected;
    if (!connected) throw new Error('Connect your Box using the BT button in the mobile app.');
    return access;
  };
  window.creator = Object.freeze({ connection: () => call('status'), midi: Object.freeze({
    send: data => output.send(data),
    onMessage: fn => { listeners.add(fn); return () => listeners.delete(fn); }
  }) });
})();
