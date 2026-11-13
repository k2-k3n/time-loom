// SPDX-License-Identifier: MIT
// Copy-free mono phrase capture: freeze one bank and record the next bank.
#include <resona/module.h>
#include <resona/math.h>
#include <resona/parameters.h>

namespace {
// Two 2.73 s PSRAM banks (512 KiB each): the longest phrase is 2 s ("1/1" at the assumed 120 BPM).
// SEAM is the loop-end crossfade, XF the fade for capture, re-capture and division changes (15 ms each).
constexpr uint32_t N = 131072, MASK = N - 1, SEAM = 720, XF = 720, LONGEST = 96000;
enum { DIVISION, COLOUR, HOLD, MIX, DECAY, BYPASS, COUNT };
const resona_param params[] = {
    {"DIVISION",0,4,3,""}, {"COLOUR",0,100,55,"%"}, {"HOLD",0,1,0,""},
    {"MIX",0,100,80,"%"}, {"DECAY",0,100,45,"%"}, {"BYPASS",0,1,0,""}
};
// Note values at an assumed 120 BPM: 2 s, 1 s, 0.5 s, 0.25 s, 0.125 s.
const char *const divisions[] = {"1/1","1/2","1/4","1/8","1/16"};
const resona_param_ext ext[] = {
    {RESONA_PARAM_CHOICE|RESONA_PARAM_STEPPED,1,5,divisions}, {},
    {RESONA_PARAM_TOGGLE,1,0,nullptr}, {}, {}, {RESONA_PARAM_TOGGLE,1,0,nullptr}
};
const resona_buffer_request requests[] = {
    {1,RESONA_MEMORY_PSRAM,N*sizeof(float),128},
    {2,RESONA_MEMORY_PSRAM,N*sizeof(float),128}
};
const resona_memory_profile memory = {RESONA_MEMORY_VERSION,sizeof(resona_memory_profile),2,requests};
struct State {
    float *bank[2];
    float value[COUNT], control[COUNT];
    resona_parameter_inbox inbox;
    uint32_t head, filled, record, frozen, capture_end, available;
    uint32_t position, old_position, length, old_length, fade, old_bank, old_end;
    float wet, filtered, tone, tone_target, tail, tail_decay, mix, bypass, old_gain;
    bool desired_hold, held, valid;
};
// Soft knee: linear to 0.8, then 0.8 + 0.19*t/(1+t) with t = (|x|-0.8)*5; never above 0.99.
float clip(float x) { float a=resona_fabsf(x);if(a<=.8f)return x;float t=(a-.8f)*5;a=.8f+.19f*t/(1+t);return x<0?-a:a; }
float flush(float x) { return resona_fabsf(x)<1e-20f?0:x; }
uint32_t length_for(const State &s) {
    uint32_t div=(uint32_t)(s.value[DIVISION]+.5f);
    if(div>4)div=4;
    uint32_t len=LONGEST>>div;
    return len<s.available?len:s.available;
}
void coefficients(State &s) {
    const float fc=650.0f+9500.0f*(s.value[COLOUR]*.01f)*(s.value[COLOUR]*.01f);
    s.tone_target=1-resona_expf(-6.2831853f*fc/48000.0f);
    // -60 dB tail in 0.25 .. 3 seconds. Calculated outside the sample loop.
    const float seconds=.25f+2.75f*s.value[DECAY]*.01f;
    s.tail_decay=resona_expf(-6.9077553f/(48000*seconds));
}
void reset(void *p) {
    State &s=*static_cast<State *>(p);
    for(uint32_t n=0;n<COUNT;n++)s.value[n]=s.control[n];
    coefficients(s);
    s.head=0;s.filled=0;s.record=0;s.frozen=1;s.capture_end=0;s.available=0;
    s.position=s.old_position=s.length=s.old_length=s.fade=s.old_bank=s.old_end=0;
    s.wet=s.filtered=s.tail=s.old_gain=0;s.mix=s.value[MIX]*.01f;
    s.tone=s.tone_target;s.bypass=s.value[BYPASS];
    s.desired_hold=s.value[HOLD]>.5f;s.held=false;s.valid=false;
    s.inbox={};
    if(s.bank[0]&&s.bank[1])for(uint32_t b=0;b<2;b++)for(uint32_t i=0;i<N;i++)s.bank[b][i]=0;
}
void init(void *p,const resona_host *h) {
    State &s=*static_cast<State *>(p);
    const resona_buffer *a=resona_buffer_find(h->memory,1),*b=resona_buffer_find(h->memory,2);
    s.bank[0]=a&&a->bytes>=requests[0].bytes?static_cast<float *>(a->data):nullptr;
    s.bank[1]=b&&b->bytes>=requests[1].bytes?static_cast<float *>(b->data):nullptr;
    for(uint32_t i=0;i<COUNT;i++)s.value[i]=s.control[i]=params[i].def;
    coefficients(s);reset(p);
}
void set(void *p,uint32_t n,float v) {
    if(n>=COUNT)return;
    State &s=*static_cast<State *>(p);
    // Producer touches only the mailbox and user-facing parameter cache.
    s.control[n]=v;
    resona_parameter_publish(&s.inbox,n,v);
}
float get(const void *p,uint32_t n) { return n<COUNT?static_cast<const State *>(p)->control[n]:0; }
// The voice that was playing (or silence) fades out over XF while the new one fades in.
void retire(State &s,float gain) {
    s.old_bank=s.frozen;s.old_end=s.capture_end;s.old_length=s.length;s.old_position=s.position;
    s.old_gain=gain;s.fade=XF;
}
void capture(State &s) {
    // No copy: freeze the current complete bank and start the other bank. The bank about to be
    // recorded may still hold the fading phrase, so recording resumes after that phrase's end.
    retire(s,s.valid?s.tail:0);s.filtered*=s.old_gain; // the tail gain restarts at 1 below
    const uint32_t resume=s.capture_end;
    s.frozen=s.record;s.capture_end=s.head;s.available=s.filled;
    s.record^=1;s.head=resume;s.filled=0;s.position=0;
    s.length=length_for(s);
    s.valid=s.length>2*SEAM;s.held=true;s.tail=1;
}
float read_loop(const float *bank,uint32_t end,uint32_t len,uint32_t pos) {
    if(len<=2*SEAM)return 0;
    uint32_t start=(end+N-len)&MASK;
    float v=bank[(start+pos)&MASK];
    if(pos>=len-SEAM) {
        uint32_t j=pos-(len-SEAM);
        float a=(float)j/(float)SEAM;
        v+=(bank[(start+j)&MASK]-v)*a;
    }
    return v;
}
void advance(uint32_t &pos,uint32_t len) { if(++pos>=len)pos=SEAM; }
void process(void *p,const float *const *inputs,float *const *outputs,uint32_t frames) {
    State &s=*static_cast<State *>(p);
    float v[12];uint32_t pending=resona_parameter_consume(&s.inbox,v);
    // Read the mailbox into audio-owned settings at block boundaries.
    for(uint32_t n=0;n<COUNT;n++)if(pending&(1u<<n))s.value[n]=v[n];
    if(pending&((1u<<COLOUR)|(1u<<DECAY)))coefficients(s);
    s.desired_hold=s.value[HOLD]>.5f;
    if(!s.desired_hold&&s.held)s.held=false;
    if(s.desired_hold&&!s.held&&s.filled>=4*SEAM)capture(s);
    if(s.valid) {
        uint32_t next=length_for(s);
        if(next!=s.length&&next>2*SEAM) {retire(s,1);s.length=next;s.position=0;}
    }
    const float mix_target=s.value[MIX]*.01f, bypass_target=s.value[BYPASS]>.5f?1.0f:0.0f;
    for(uint32_t i=0;i<frames;i++) {
        float dry=inputs[0][i];
        if(!s.bank[0]||!s.bank[1]){outputs[0][i]=dry;continue;}
        s.bank[s.record][s.head]=dry;s.head=(s.head+1)&MASK;if(s.filled<N)s.filled++;
        s.tone+=(s.tone_target-s.tone)*.002f;
        s.mix+=(mix_target-s.mix)*.002f;s.bypass+=(bypass_target-s.bypass)*.002f;
        if(resona_fabsf(bypass_target-s.bypass)<2e-5f)s.bypass=bypass_target;
        float loop=0;
        if(s.valid) {
            loop=read_loop(s.bank[s.frozen],s.capture_end,s.length,s.position);advance(s.position,s.length);
        }
        if(s.fade) {
            float old=s.old_gain*read_loop(s.bank[s.old_bank],s.old_end,s.old_length,s.old_position);advance(s.old_position,s.old_length);
            float a=1-(float)s.fade/XF;loop=old+(loop-old)*a;s.fade--;
        }
        if(!s.held)s.tail*=s.tail_decay;
        if(s.tail<1e-5f){s.tail=0;if(!s.held)s.valid=false;}
        s.filtered=flush(s.filtered+s.tone*(loop-s.filtered));
        const float target=s.held?1.0f:0.0f;s.wet+=(target-s.wet)*.0015f;
        // Hold: live guitar dips at most ~3 dB (0.71 at MIX 80); release: new dry notes
        // return over a decaying, darkening frozen phrase (no feedback loop).
        float effect=dry*(1-.36f*s.wet*s.mix)+s.filtered*s.tail*s.mix*.8f;
        outputs[0][i]=dry+(clip(effect)-dry)*(1.0f-s.bypass);
    }
}
void cpu(void *p,uint32_t phase) {
    State &s=*static_cast<State *>(p);
    if(phase==RESONA_CPU_TRIAL_ACTIVE) {
        set(p,COLOUR,100);set(p,DECAY,100);set(p,MIX,100);set(p,HOLD,1);
        // Trial must exercise captured audio even before the test has supplied
        // a whole phrase. This is disposable instance preparation, not process.
        if(s.bank[0])for(uint32_t i=0;i<LONGEST;i++)s.bank[0][i]=(i&64u)?.2f:-.2f;
        s.record=0;s.head=LONGEST;s.filled=LONGEST;
    } else if(phase==RESONA_CPU_TRIAL_TRANSITION) {
        set(p,DIVISION,4);set(p,COLOUR,0);
    } else if(phase==RESONA_CPU_TRIAL_RELEASE)set(p,HOLD,0);
}
const resona_cpu_profile profile={RESONA_CPU_PROFILE_VERSION,sizeof(resona_cpu_profile),0,cpu};
const resona_module module={RESONA_MODULE_ABI,sizeof(resona_module),
    "org.resona.demo.time-loom-dsp","Time Loom DSP","0.1.2",
    RESONA_LAYOUT_MONO,RESONA_RATE_48000,sizeof(State),COUNT,params,ext,
    init,reset,set,process,nullptr,nullptr,get,&profile,&memory};
}
extern "C" RESONA_EXPORT const resona_module *resona_module_get(){return &module;}
