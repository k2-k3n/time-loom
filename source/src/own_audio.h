// App-owned audio (platform API 1). MIT.
//
// The App builds its own effect graph instead of playing a preset:
//   Guitar -> effect(s) -> Output L/R and Capture L/R; USB and Bluetooth L/R -> Output.
// Effects are created by package id (the id in each dsp project's resona.project.json).
#pragma once
#include <resona/platform.h>
#include <resona/effects.hpp>

namespace own_audio {

struct Graph {
    resona::Effects fx;
    resona_effect_handle h[2];
    uint32_t count;
    int owned;
};

// Create the chain ids[0] -> ids[1] ... (n <= 2) once. Returns 0, or a RESONA_ERR_*;
// safe to call again after a failure (e.g. once the pack is installed).
inline int start(const resona_platform *P, Graph &g, const char *const *ids, uint32_t n, const char *version) {
    if (g.count) return RESONA_OK;
    if (n == 0 || n > 2) return RESONA_ERR_ARG;
    if (!g.owned) { int rc = g.fx.begin(P); if (rc) return rc; g.owned = 1; }
    resona_effect_handle h[2] = {0, 0};
    for (uint32_t i = 0; i < n; ++i) {
        g.fx.clear_error();
        h[i] = g.fx.pack(ids[i], version);
        if (!h[i]) {
            int rc = g.fx.error() ? g.fx.error() : RESONA_ERR_STATE;
            for (uint32_t k = 0; k < i; ++k) P->effect_destroy(h[k]);
            return rc;
        }
    }
    g.fx.clear_error();
    g.fx.clear_routes();
    g.fx.connect(g.fx.Guitar, h[0], 1.0f, 0, 0);
    for (uint32_t i = 1; i < n; ++i) g.fx.connect(h[i - 1], h[i], 1.0f, 0, 0);
    const resona_effect_handle last = h[n - 1];
    g.fx.output(last);
    g.fx.connect(g.fx.Usb, g.fx.Output, 1.0f, 0, 0);
    g.fx.connect(g.fx.Usb, g.fx.Output, 1.0f, 1, 1);
    g.fx.connect(g.fx.Bluetooth, g.fx.Output, 1.0f, 0, 0);
    g.fx.connect(g.fx.Bluetooth, g.fx.Output, 1.0f, 1, 1);
    g.fx.capture(last);
    int rc = g.fx.commit();
    if (rc) { for (uint32_t k = 0; k < n; ++k) P->effect_destroy(h[k]); g.fx.clear_error(); return rc; }
    for (uint32_t i = 0; i < n; ++i) g.h[i] = h[i];
    g.count = n;
    return RESONA_OK;
}

// Destroy the chain so the next start() builds it afresh (after a fault the OS wants the
// processor recreated, not just re-enabled).
inline void stop(const resona_platform *P, Graph &g) {
    for (uint32_t i = 0; i < g.count; ++i) { P->effect_destroy(g.h[i]); g.h[i] = 0; }
    g.count = 0;
}

inline int start(const resona_platform *P, Graph &g, const char *id, const char *version) { return start(P, g, &id, 1, version); }

}  // namespace own_audio
