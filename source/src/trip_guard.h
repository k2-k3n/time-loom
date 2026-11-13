// MIT. What an App does when the OS bypasses its effect for running over the CPU budget.
//
// Re-enabling at once makes a guitarist hear a dropout every second or two. Instead each trip
// waits longer before audio is tried again: 2 s, then 10 s, then 30 s while trips keep coming
// (a minute without one starts over). The App shows "CPU LIMIT" while it waits.
//
// How a trip is seen: platform API 1 no longer names the effect in RESONA_APP_EV_AUDIO
// (tripped_role is -1), so poll faulted() about once a second while audio runs. A faulted
// processor must be recreated (cpu-qualification.md: "Reload/recreate a faulted processor"),
// so after the wait the App rebuilds its graph (own_audio::stop, then start) rather than only
// calling effect_enable again.
#pragma once
#include <stdint.h>
#include <resona/platform.h>

namespace trip_guard {

struct Guard {
    uint32_t trips, last;
};

// The OS bypassed one of our effects at time `now` (ms). Returns how long to wait, in ms,
// before enabling audio again.
inline uint32_t tripped(Guard &g, uint32_t now)
{
    if (g.trips && now - g.last > 60000u) g.trips = 0;
    g.last = now;
    ++g.trips;
    return g.trips == 1 ? 2000u : (g.trips == 2 ? 10000u : 30000u);
}

// True when the OS has bypassed this effect (time guard, access or non-finite fault).
inline bool faulted(const resona_platform *P, resona_effect_handle h)
{
    if (!P || !h) return false;
    resona_effect_info fi = {};
    return P->effect_info(h, &fi) == RESONA_OK && fi.fault != 0;
}

// Audio has run cleanly for a while, or the user asked to retry: start over.
inline void clear(Guard &g) { g.trips = 0; }

}  // namespace trip_guard
