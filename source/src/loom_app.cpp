// SPDX-License-Identifier: MIT
// The Web, Mobile and MIDI controllers (controller/, CCs on channel 1, see README.md) reach every setting the knobs
// reach, plus TAIL on its own and the REPEATS level, show what the loom is doing, and add three hold pads: HOLD
// (capture, like holding the big knob), STUTTER (capture a 1/16 phrase; it unravels at 1/16) and DRY.
#include <resona/platform.h>
#include <resona/startup_helpers.h>
#include "splash_data.h"
#include "demo_capture.h"
#include <resona/ui.h>
#include <resona/math.h>
#include <stddef.h>
#include "art.h"
#include "own_audio.h"
#include "trip_guard.h"
#include "controller_link.h"

namespace {
const resona_platform *P;
own_audio::Graph g_audio; // Guitar -> Time Loom DSP -> Output, owned by the App
enum { DIVISION, COLOUR, HOLD, MIX, DECAY, BYPASS };
constexpr uint16_t PAPER=RESONA_RGB(244,240,229),INK=RESONA_RGB(10,25,55),RUST=RESONA_RGB(202,69,24);
// Note values at an assumed 120 BPM (README): 2 s, 1 s, 0.5 s, 0.25 s, 0.125 s phrases.
const char *const fractions[]={"1/1","1/2","1/4","1/8","1/16"};
// Stored settings: magic, then validated fields. The top knob sets TAIL with TONE (decay = 100 - colour);
// a controller sets it on its own. v1 had no decay/mix (decay was 100 - colour, mix 80).
struct SavedV1{uint32_t magic;int32_t division,colour,bypass;};
struct Saved{uint32_t magic;int32_t division,colour,bypass,decay,mix;};
constexpr uint32_t kMagicV1=0x544c4d31,kMagic=0x544c4d32;
// The controllers' MIDI map: CC on channel 1 (controller/shared/profile.js says the same).
enum{CC_DIVISION=20,CC_TONE,CC_TAIL,CC_REPEATS,CC_DRY,CC_STATE,CC_HOLD=30,CC_STUTTER,CC_HUSH};
struct State {
    uint32_t ms,last_draw,tail_until,retry,down_ms[2],changed;
    int division,colour,decay,mix,held,bypass,ready,error;
    int padHold,padStutter,stutter,padDry,phase; // controller pads; stutter lasts through its tail; phase: LIVE/CAPTURED/UNRAVEL/DRY
    ctl::Link link;
    bool keys[2],suppress[2],dirty,save;
    uint8_t input,out,cpu;
    trip_guard::Guard trip;
};
int bound(int x,int a,int b){return x<a?a:(x>b?b:x);}
ctl::Bind kBind[9];
void bind(State &s){
    const ctl::Bind b[9]={{CC_DIVISION,ctl::STEPS,0,4,&s.division},{CC_TONE,ctl::RANGE,0,100,&s.colour},{CC_TAIL,ctl::RANGE,0,100,&s.decay},
        {CC_REPEATS,ctl::RANGE,0,100,&s.mix},{CC_DRY,ctl::STEPS,0,1,&s.bypass},{CC_STATE,ctl::READ_STEPS,0,3,&s.phase},
        {CC_HOLD,ctl::TRIGGER,0,1,nullptr},{CC_STUTTER,ctl::TRIGGER,0,1,nullptr},{CC_HUSH,ctl::TRIGGER,0,1,nullptr}};
    for(int i=0;i<9;++i)kBind[i]=b[i];
}
// What the pads override while held: STUTTER loops 1/16, DRY bypasses.
int division_now(const State &s){return s.stutter?4:s.division;}
int bypass_now(const State &s){return s.bypass||s.padDry;}
void checked(State &s,int rc){if(rc<0){s.error=rc;s.dirty=true;}}
void parameter(State &s,uint32_t n,float value){
    if(!s.ready)return;
    checked(s,P->effect_param_set(g_audio.h[0],n,value));
}
void values(State &s){parameter(s,DIVISION,(float)division_now(s));parameter(s,COLOUR,(float)s.colour);parameter(s,HOLD,(float)s.held);parameter(s,MIX,(float)s.mix);parameter(s,DECAY,(float)s.decay);parameter(s,BYPASS,(float)bypass_now(s));}
void capture(State &s,bool on){
    if(on&&s.stutter&&!s.padStutter){s.stutter=0;parameter(s,DIVISION,(float)s.division);} // a plain capture ends a stutter tail
    if(s.held==(int)on)return;s.held=on;parameter(s,HOLD,on?1:0);if(!on)s.tail_until=s.ms+250+2750u*(uint32_t)s.decay/100u;s.dirty=true;}
void key(State &s,uint32_t enc,bool down){
    if(enc>1||s.keys[enc]==down)return;s.keys[enc]=down;
    if(down){s.down_ms[enc]=s.ms;s.suppress[enc]=enc==1;if(enc==1)capture(s,true);}
    else if(enc==1&&!s.padHold&&!s.padStutter)capture(s,false);
}
void input(State &s,const resona_event &e){
    uint32_t n=e.input;if(n>1)return;
    if(e.kind!=RESONA_EVENT_LONG||n==0){s.changed=s.ms;s.save=true;}
    if(e.kind==RESONA_EVENT_TURN){
        if(n==0){s.colour=bound(s.colour+e.value*3,0,100);s.decay=100-s.colour;parameter(s,COLOUR,(float)s.colour);parameter(s,DECAY,(float)s.decay);}
        else {s.division=bound(s.division+e.value,0,4);parameter(s,DIVISION,(float)division_now(s));}
    } else if(e.kind==RESONA_EVENT_CLICK){
        if(s.suppress[n]){s.suppress[n]=false;return;}
        if(n==0){s.bypass=!s.bypass;parameter(s,BYPASS,(float)bypass_now(s));}else capture(s,!s.held);
    } else if(e.kind==RESONA_EVENT_LONG){
        if(n==1&&!s.keys[1])capture(s,!s.held);
        else if(n==0){s.suppress[0]=true;s.colour=55;s.decay=45;s.bypass=0;values(s);
            if(!s.ready&&s.error==RESONA_ERR_BUDGET){trip_guard::clear(s.trip);s.retry=0;}} // also: retry audio now
    }
    s.dirty=true;
}
#ifdef RESONA_DEMO_BENCH
// Bench-only: MIDI channel 16 CC20..27 emulate the encoders and keys.
void midi(State &s,const uint8_t *m,uint32_t len){
    if(len<3||m[0]!=0xbf)return;uint8_t cc=m[1],v=m[2];
    if(cc==22||cc==23){key(s,cc-22,v>=64);return;}
    resona_event ev={};
    if(cc==20||cc==21){ev.kind=RESONA_EVENT_TURN;ev.input=cc-20;ev.value=(int)v-64;}
    else if(cc>=24&&cc<=27){ev.input=(cc-24)&1u;ev.kind=cc<26?RESONA_EVENT_CLICK:RESONA_EVENT_LONG;ev.value=1;}
    else return;input(s,ev);
}
#endif
// The OS bypassed the DSP (CPU time guard or fault): drop the graph and rebuild it after a growing wait.
void trip(State &s){s.ready=0;s.error=RESONA_ERR_BUDGET;s.retry=s.ms+trip_guard::tripped(s.trip,s.ms);own_audio::stop(P,g_audio);s.dirty=true;}
void setup(State &s){
    if(s.ms<s.retry)return;s.retry=s.ms+1000;
    if(s.ready&&trip_guard::faulted(P,g_audio.h[0])){trip(s);return;}
    // The App owns audio: it creates the Time Loom DSP by package id and routes
    // Guitar -> loom -> Output itself (own_audio.h). Retried until it is installed.
    int rc=own_audio::start(P,g_audio,"org.resona.demo.time-loom-dsp","0.1.2"); // dsp/resona.project.json
    resona_effect_info fi={};
    if(rc>=0)rc=P->effect_info(g_audio.h[0],&fi);
    if(rc<0||fi.param_count!=6){
        const int e=rc<0?rc:RESONA_ERR_STATE;
        if(s.ready||s.error!=e)s.dirty=true;
        s.ready=0;s.error=e;return;
    }
    if(!s.ready){
        rc=P->effect_enable(g_audio.h[0],1);
        if(rc<0){s.error=rc;s.dirty=true;return;}
        s.ready=1;s.error=0;values(s);s.dirty=true;
    }else if(s.error){s.error=0;values(s);s.dirty=true;} // audio is up: drop a stale error, resend
}
// RGB565 has at most six channel bits. A 5-bit coverage blend avoids
// three integer divisions per glyph pixel and preserves a smooth text edge.
uint16_t blend(uint16_t a,uint16_t b,uint32_t alpha){
    uint32_t cover=(alpha+4u)>>3,inv=32u-cover;
    uint32_t aa=((uint32_t)a|((uint32_t)a<<16))&0x07e0f81fu;
    uint32_t bb=((uint32_t)b|((uint32_t)b<<16))&0x07e0f81fu;
    uint32_t c=((aa*inv+bb*cover)>>5)&0x07e0f81fu;
    return (uint16_t)(c|(c>>16));
}
// Background is pre-baked RGB565 words, not an indexed image. One sequential
// source read and destination write per pair of pixels; no palette/warp/math
// in the full-screen path. Eight words per iteration amortize the MCU loop.
void background(uint16_t *px,uint32_t stride){
    if((((uintptr_t)px&3u)==0)&&((stride&1u)==0)){
        typedef uint32_t Word __attribute__((may_alias));
        for(uint32_t y=0;y<172;y++){
            Word *dst=reinterpret_cast<Word *>(px+y*stride);
            const uint32_t *src=loom_art_words+y*160;
            for(uint32_t x=0;x<160;x+=8){
                dst[x]=src[x];dst[x+1]=src[x+1];dst[x+2]=src[x+2];dst[x+3]=src[x+3];
                dst[x+4]=src[x+4];dst[x+5]=src[x+5];dst[x+6]=src[x+6];dst[x+7]=src[x+7];
            }
        }
    }else{
        // An unusual host surface may have only halfword alignment. Preserve
        // the same pixels without issuing unaligned 32-bit memory operations.
        for(uint32_t y=0;y<172;y++)for(uint32_t x=0;x<160;x++){
            uint32_t word=loom_art_words[y*160+x];
            px[y*stride+x*2]=(uint16_t)word;px[y*stride+x*2+1]=(uint16_t)(word>>16);
        }
    }
}
void text(uint16_t *px,uint32_t stride,int x,int y,const char *t,uint16_t colour,bool large=false){
    for(int n=0;t[n]&&n<30;n++){
        char c=t[n];int glyph=large?(c=='/'?10:c-'0'):c-32;
        int w=large?30:10,h=large?46:16;
        if(glyph<0||glyph>=(large?11:59)){x+=large?24:7;continue;}
        const uint8_t *mask=(large?loom_large:loom_small)+glyph*w*h;
        for(int j=0;j<h;j++)for(int i=0;i<w;i++){
            int xx=x+i,yy=y+j;if(xx<0||xx>=320||yy<0||yy>=172)continue;
            uint8_t a=mask[j*w+i];if(a){uint16_t &dst=px[(uint32_t)yy*stride+(uint32_t)xx];dst=a>=252?colour:blend(dst,colour,a);}
        }
        x+=large?(c=='/'?17:25):(c==' '?4:7);
    }
}
void draw(State &s){
    uint16_t *px=nullptr;uint32_t stride=0;resona_ui *ui=P->screen_begin(&px,&stride);if(!ui||!px||stride<320)return;
    background(px,stride);
    char buf[24];
    const char *status=bypass_now(s)?"DRY":s.held?"CAPTURED":s.ms<s.tail_until?"UNRAVEL":"LIVE";
    if(!s.ready&&s.error==RESONA_ERR_BUDGET)text(px,stride,215,23,"CPU LIMIT",RUST);
    else if(!s.ready){text(px,stride,215,9,"INSTALL",RUST);text(px,stride,215,25,"LOOM DSP",RUST);}
    else text(px,stride,215,23,status,INK);
    text(px,stride,6,125,fractions[division_now(s)],INK,true);
    P->format(buf,sizeof buf,"TONE %02d",s.colour);text(px,stride,118,133,buf,INK);
    P->format(buf,sizeof buf,"TAIL %02d",s.decay);text(px,stride,118,150,buf,INK);
    ui->rect(ui->ctx,226,128,87,38,RUST);
    text(px,stride,235,131,s.held?"RELEASE":"HOLD TO",PAPER);
    text(px,stride,235,148,s.held?"UNRAVEL":"CAPTURE",PAPER);
    // Real moving capture shuttle, with speed following the selected division.
    int span=220,period=2000>>division_now(s); // the phrase length in ms
    int pos=60+(int)((s.ms%(uint32_t)period)*(uint32_t)span/(uint32_t)period);
    if(s.held||s.ms<s.tail_until){ui->rect(ui->ctx,pos,43,2,78,RUST);ui->rect(ui->ctx,pos-2,40,6,3,RUST);}
    // Small but honest input meter. The local UI model reports zero.
    if(s.ready){ui->rect(ui->ctx,215,11,94,3,RESONA_RGB(222,214,198));
    ui->rect(ui->ctx,215,11,(int)s.input*10,3,RUST);}
    if(s.error&&s.error!=RESONA_ERR_BUDGET){P->format(buf,sizeof buf,"ERR %d",s.error);text(px,stride,214,39,buf,RUST);}
    demo_capture::remember(px,stride);P->screen_present(0,0,0,0);s.last_draw=s.ms;s.dirty=false;
}
int init(void *p,const resona_platform *platform){
    P=platform;State &s=*static_cast<State *>(p);s.division=3;s.colour=55;s.decay=45;s.mix=80;s.dirty=true;
    Saved v={};
    if(P->app_store_read(0,&v,sizeof v)==RESONA_OK&&(v.magic==kMagic||v.magic==kMagicV1)){
        s.division=bound(v.division,0,4);s.colour=bound(v.colour,0,100);s.bypass=v.bypass?1:0;
        if(v.magic==kMagic){s.decay=bound(v.decay,0,100);s.mix=bound(v.mix,0,100);}else s.decay=100-s.colour;}
    bind(s);
    P->input_config(RESONA_INPUT_SELECTOR,0);P->input_config(RESONA_INPUT_CUSTOMIZE,0);
    const int splash = resona_startup_splash_apply(P, kSplash, sizeof kSplash);
    if(splash == RESONA_STARTUP_REBOOT_REQUIRED) P->log("Time Loom: startup animation ready for the next boot");
    else if(splash < 0 && splash != RESONA_ERR_UNSUPPORTED) P->log("Time Loom: startup animation could not be saved");
    P->log("Time Loom: App-owned audio, Guitar -> Time Loom DSP -> Output");
    return RESONA_OK;
}
void event(void *p,const resona_app_event *ev){
 if(demo_capture::event(P,ev))return;
    State &s=*static_cast<State *>(p);
    ctl::Msg m;
    if(ctl::receive(P,s.link,kBind,9,ev,m)){
        if(!m.changed)return;
        if(m.cc==CC_HOLD){s.padHold=m.down;if(m.down)capture(s,true);else if(!s.keys[1]&&!s.padStutter)capture(s,false);}
        else if(m.cc==CC_STUTTER){s.padStutter=m.down;
            if(m.down){s.stutter=1;parameter(s,DIVISION,4);capture(s,true);}else if(!s.keys[1]&&!s.padHold)capture(s,false);}
        else if(m.cc==CC_HUSH){s.padDry=m.down;parameter(s,BYPASS,(float)bypass_now(s));}
        else{s.changed=s.ms;s.save=true;
            if(m.cc==CC_DIVISION)parameter(s,DIVISION,(float)division_now(s));else if(m.cc==CC_TONE)parameter(s,COLOUR,(float)s.colour);
            else if(m.cc==CC_TAIL)parameter(s,DECAY,(float)s.decay);else if(m.cc==CC_REPEATS)parameter(s,MIX,(float)s.mix);
            else if(m.cc==CC_DRY)parameter(s,BYPASS,(float)bypass_now(s));}
        s.dirty=true;return;
    }
    if(ev->kind==RESONA_APP_EV_INPUT)input(s,ev->u.input);
    else if(ev->kind==RESONA_APP_EV_KEY)key(s,ev->u.key.key,ev->u.key.down!=0);
#ifdef RESONA_DEMO_BENCH
    else if(ev->kind==RESONA_APP_EV_MIDI)midi(s,ev->u.midi.data,ev->u.midi.len);
#endif
    else if(ev->kind==RESONA_APP_EV_CHANGED){
        if(ev->u.changed.what==RESONA_CHANGED_PRESET||ev->u.changed.what==RESONA_CHANGED_MODELS){
            if(s.error!=RESONA_ERR_BUDGET){s.ready=0;s.retry=0;s.dirty=true;}
        }
        // Parameter writes generate BLOCK notifications too. Do not echo
        // those into setup/parameter-write loops; the 1 Hz health poll owns it.
    }else if(ev->kind==RESONA_APP_EV_AUDIO){
        if(ev->u.audio.tripped_role>=0||(s.ready&&trip_guard::faulted(P,g_audio.h[0])))trip(s);
    }
}
void frame(void *p,uint32_t ms){ if(demo_capture::paused(P))return;State &s=*static_cast<State *>(p);s.ms+=ms;setup(s);
    // Debounced save; a failed write is retried on the next change and is not an audio error.
    if(s.save&&s.ms-s.changed>1200&&!s.held){Saved v={kMagic,s.division,s.colour,s.bypass,s.decay,s.mix};s.save=false;(void)P->app_store_write(0,&v,sizeof v);}
    // a stutter's 1/16 lasts through its tail, then the chosen division returns
    if(s.stutter&&!s.padStutter&&!s.held&&s.ms>=s.tail_until){s.stutter=0;parameter(s,DIVISION,(float)s.division);s.dirty=true;}
    s.phase=bypass_now(s)?3:s.held?1:s.ms<s.tail_until?2:0;ctl::sync(P,s.link,kBind,9,s.ms);
    P->meters(&s.input,&s.out,&s.cpu);if(s.dirty||s.ms-s.last_draw>=66)draw(s);}
const resona_app app={RESONA_PLATFORM_VERSION,sizeof(resona_app),RESONA_APP_ID,RESONA_APP_NAME,RESONA_APP_VERSION,sizeof(State),1024,init,event,frame};
}
extern "C" const resona_app *resona_app_get(){return &app;}
