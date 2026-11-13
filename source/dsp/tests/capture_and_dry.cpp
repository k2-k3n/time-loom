#include <resona/module.h>
#include <array>
#include <cmath>
#include <cstdio>

extern "C" const resona_module *resona_module_get();
int main() {
    const auto &module = *resona_module_get();
    alignas(128) static float banks[2][131072];
    const resona_buffer buffers[] = {
        {1, RESONA_MEMORY_PSRAM, sizeof banks[0], banks[0]},
        {2, RESONA_MEMORY_PSRAM, sizeof banks[1], banks[1]},
    };
    const resona_memory_context memory{RESONA_MEMORY_VERSION, sizeof memory, 2, buffers};
    resona_host host{};
    host.memory = &memory;
    alignas(128) unsigned char state[4096]{};
    module.init(state, &host);
    float dryError = 0;
    for (int division = 0; division < 5; ++division) {
        module.reset(state);
        module.set_param(state, 0, division);
        module.set_param(state, 4, 0);
        float capturePeak = 0, releasePeak = 0, latePeak = 0;
        for (unsigned pos = 0; pos < 184320; pos += 64) {
            if (pos == 98304) module.set_param(state, 2, 1);
            if (pos == 114688) module.set_param(state, 2, 0);
            if (pos == 147456) module.set_param(state, 5, 1);
            if (pos == 163840) module.set_param(state, 5, 0);
            std::array<float,64> in{}, out{};
            for (unsigned i=0; i<64; ++i) {
                if (pos < 98304) in[i]=.25f*std::sin((pos+i)*.0576f);
                if (pos >= 147456 && pos < 163840) in[i]=(i&1)?1.f:-1.f;
            }
            const float *x=in.data(); float *y=out.data();
            module.process(state,&x,&y,in.size());
            for (unsigned i=0; i<64; ++i) {
                const float sample=std::abs(out[i]);
                if (!std::isfinite(sample) || sample>1) return 2;
                if (pos>=102400 && pos<114688) capturePeak=std::fmax(capturePeak,sample);
                if (pos>=114688 && pos<115712) releasePeak=std::fmax(releasePeak,sample);
                if (pos>=130048 && pos<131072) latePeak=std::fmax(latePeak,sample);
                if (pos>=155648 && pos<163840) dryError=std::fmax(dryError,std::abs(out[i]-in[i]));
            }
        }
        std::printf("division %d: capture %.4f, release %.4f, late %.6f\n", division, capturePeak,releasePeak,latePeak);
        if (capturePeak < .05f || releasePeak < .025f || latePeak >= .001f) return 3;
    }
    std::printf("full-scale DRY error %.9g\n",dryError);
    return dryError==0?0:1;
}
