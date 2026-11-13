// MIT. Optional bench capture of this App's public SDK screen buffer only.
// Compiled in only with -DRESONA_DEMO_BENCH (bench and screenshot builds). A normal build gets
// the no-op versions below, so no SysEx command can freeze the App's frame loop in the field.
// No firmware memory, private transport, preset, settings or flash access.
#pragma once
#include <resona/platform.h>
namespace demo_capture {
#ifndef RESONA_DEMO_BENCH
static inline void remember(const uint16_t *, uint32_t) {}
static inline bool paused(const resona_platform *) { return false; }
static inline bool event(const resona_platform *, const resona_app_event *) { return false; }
}
#else
static const uint16_t *pixels;
static uint32_t stride, until;
static bool frozen;
static void remember(const uint16_t *p,uint32_t s){if(!frozen){pixels=p;stride=s;}}
static bool paused(const resona_platform *p){if(frozen&&static_cast<int32_t>(p->millis()-until)>0)frozen=false;return frozen;}
static bool event(const resona_platform *p,const resona_app_event *e){
 if(e->kind!=RESONA_APP_EV_MIDI||e->u.midi.len<8)return false;
 const uint8_t *m=e->u.midi.data;
 // F0 7D 52 42 58 53 command token [offset:3x7bit] F7
 if(m[0]!=0xf0||m[1]!=0x7d||m[2]!=0x52||m[3]!=0x42||m[4]!=0x58||m[5]!=0x53)return false;
 uint8_t out[248]={0xf0,0x7d,0x52,0x42,0x58,0x53,0x40,m[6],m[7]};
 int n=9;const uint8_t command=m[6];
 if(command==0){
  frozen=pixels!=nullptr;until=p->millis()+15000;
  out[n++]=frozen?1:0;out[n++]=64;out[n++]=2;out[n++]=44;out[n++]=1; // 320 x 172, 7-bit words
 }else if(command==1&&e->u.midi.len>=12&&frozen&&pixels){
  const uint32_t off=static_cast<uint32_t>(m[8])|(static_cast<uint32_t>(m[9])<<7)|(static_cast<uint32_t>(m[10])<<14);
  out[n++]=m[8];out[n++]=m[9];out[n++]=m[10];
  uint8_t raw[196];int raw_n=0;
  for(uint32_t i=off;i<320u*172u&&i<off+98u;++i){
   const uint16_t c=pixels[(i/320u)*stride+i%320u];raw[raw_n++]=static_cast<uint8_t>(c);raw[raw_n++]=static_cast<uint8_t>(c>>8);
  }
  for(int i=0;i<raw_n;i+=7){
   int count=raw_n-i;if(count>7)count=7;int prefix=n++;out[prefix]=0;
   for(int k=0;k<count;++k){out[prefix]|=static_cast<uint8_t>((raw[i+k]>>7)<<k);out[n++]=raw[i+k]&127;}
  }
 }else if(command==2){frozen=false;out[n++]=1;}else{out[n++]=0;}
 out[n++]=0xf7;
 (void)p->midi_send(RESONA_MIDI_USB,out,static_cast<uint32_t>(n));
 return true;
}
}
#endif
