// controller_link.h: the App side of the Web, Mobile and MIDI controllers. MIT.
//
// Every App control is one MIDI CC on channel 1, from USB, Bluetooth or the MIDI jack, so a
// browser, the phone app or any MIDI controller can play the App:
//
//   RANGE    CC 0..127 maps linearly onto lo..hi            (a knob or fader)
//   STEPS    CC value is the step index: 0 = lo, 1 = lo+1    (a choice; a toggle is 0..1)
//   TRIGGER  127 (any value >= 64) presses, 0 releases       (a pad)
//   READ     like RANGE/STEPS, but the App only reports it   (what the App decided: a slot result)
//
// CC 119 (any value) asks for everything: the App answers with every value, and from then on
// sends each change (from its knobs too) and the input/output meters on CC 116/117 to that
// port. Ports that never asked get nothing back, so a DAW or pedal is never flooded.
//
// Call ctl::receive from the App's event handler and ctl::sync from its frame function.
// The copy in each App's src/ comes from _controller_kit/device/; edit it there.
#pragma once
#include <resona/platform.h>

namespace ctl {

enum : uint8_t { RANGE, STEPS, TRIGGER, READ_RANGE, READ_STEPS };
enum : uint8_t { CH = 0, CC_METER_IN = 116, CC_METER_OUT = 117, CC_QUERY = 119 };

struct Bind {
    uint8_t cc, kind;
    int lo, hi;
    int *value;   // nullptr for a TRIGGER
};

struct Msg {
    int index;    // into the Bind table
    uint8_t cc, raw;
    bool changed; // the bound value changed (always true for a TRIGGER)
    bool down;    // TRIGGER: pressed
};

struct Link {   // zero-initialised in the App's state; nothing is sent until a port asks
    uint8_t sent[128];
    uint8_t subs;        // bit per RESONA_MIDI_* port that asked (CC 119)
    uint8_t meter[2];
    uint32_t meter_at;
};

inline int clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

inline uint8_t to_cc(const Bind &b)
{
    const int v = b.value ? clamp(*b.value, b.lo, b.hi) : 0;
    if (b.kind == STEPS || b.kind == READ_STEPS) return (uint8_t)clamp(v - b.lo, 0, 127);
    if (b.hi == b.lo) return 0;
    return (uint8_t)((v - b.lo) * 127 * 2 / (b.hi - b.lo) + 1) / 2;   // rounded
}

inline int from_cc(const Bind &b, int cc)
{
    if (b.kind == STEPS) return clamp(b.lo + cc, b.lo, b.hi);
    return b.lo + ((b.hi - b.lo) * cc * 2 + 127) / 254;                 // rounded
}

inline void send(const resona_platform *P, uint32_t port, uint8_t cc, uint8_t v)
{
    const uint8_t m[3] = {(uint8_t)(0xB0 | CH), cc, (uint8_t)(v & 0x7F)};
    P->midi_send(port, m, 3);
}

inline void reset(Link &l)
{
    for (int i = 0; i < 128; ++i) l.sent[i] = 0xFF;
    l.meter[0] = l.meter[1] = 0xFF;
}

// True when the event was one of ours. For a TRIGGER, or a changed value, `out` says which.
// The App applies the change (push its parameters, save, animate) when out.changed is set.
inline bool receive(const resona_platform *P, Link &l, const Bind *b, int n,
                    const resona_app_event *ev, Msg &out)
{
    if (!P || !ev || ev->kind != RESONA_APP_EV_MIDI || ev->u.midi.len != 3 || !ev->u.midi.data) return false;
    const uint8_t *d = ev->u.midi.data;
    if (d[0] != (0xB0 | CH)) return false;
    const uint8_t cc = d[1] & 0x7F, v = d[2] & 0x7F;
    if (cc == CC_QUERY) {
        if (ev->u.midi.port < 8) l.subs |= (uint8_t)(1u << ev->u.midi.port);
        reset(l);   // the next sync sends every value
        out = {-1, cc, v, false, false};
        return true;
    }
    for (int i = 0; i < n; ++i) {
        if (b[i].cc != cc) continue;
        out = {i, cc, v, false, v >= 64};
        if (b[i].kind == TRIGGER) { out.changed = true; return true; }
        if (b[i].kind == READ_RANGE || b[i].kind == READ_STEPS || !b[i].value) {
            l.sent[cc] = 0xFF;   // re-assert the App's value
            return true;
        }
        const int nv = from_cc(b[i], v);
        out.changed = nv != *b[i].value;
        *b[i].value = nv;
        l.sent[cc] = 0xFF;      // always answer, so the controller sees its value accepted
        return true;
    }
    return false;
}

// Sends what changed to the ports that asked, and the meters about 12 times a second.
inline void sync(const resona_platform *P, Link &l, const Bind *b, int n, uint32_t now)
{
    if (!P || !P->midi_send || !l.subs) return;
    for (int i = 0; i < n; ++i) {
        if (b[i].kind == TRIGGER || !b[i].value || b[i].cc > 127) continue;
        const uint8_t v = to_cc(b[i]);
        if (l.sent[b[i].cc] == v) continue;
        l.sent[b[i].cc] = v;
        for (uint32_t port = 0; port < 3; ++port)
            if (l.subs & (1u << port)) send(P, port, b[i].cc, v);
    }
    if (now - l.meter_at < 80u || !P->meters) return;
    l.meter_at = now;
    uint8_t in = 0, out = 0;
    P->meters(&in, &out, nullptr);
    const uint8_t m[2] = {(uint8_t)clamp(in * 14, 0, 127), (uint8_t)clamp(out * 14, 0, 127)};
    for (int k = 0; k < 2; ++k) {
        if (m[k] == l.meter[k]) continue;
        l.meter[k] = m[k];
        for (uint32_t port = 0; port < 3; ++port)
            if (l.subs & (1u << port)) send(P, port, k ? CC_METER_OUT : CC_METER_IN, m[k]);
    }
}

}  // namespace ctl
