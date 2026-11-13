#!/usr/bin/env python3
"""Targeted host tests against the built public module ABI. Never opens USB/audio."""
import ctypes as C
import json, math, pathlib, wave, struct
ROOT=pathlib.Path(__file__).resolve().parents[1]
U=C.c_uint32; P=C.c_void_p; F=C.c_float
class Buffer(C.Structure): _fields_=[('id',U),('region',U),('bytes',U),('data',P)]
class Memory(C.Structure): _fields_=[('version',U),('size',U),('count',U),('buffers',C.POINTER(Buffer))]
class Host(C.Structure): _fields_=[('abi',U),('rate',U),('frames',U),('channels',U),('controls',U),('device',C.c_char_p),('log',P),('size',U),('memory',C.POINTER(Memory)),('tools',P)]
class Module(C.Structure): _fields_=[('abi',U),('size',U),('id',C.c_char_p),('name',C.c_char_p),('version',C.c_char_p),('layouts',U),('rates',U),('state',U),('count',U),('params',P),('ext',P),('init',P),('reset',P),('set',P),('process',P),('ui',P),('event',P),('get',P),('cpu',P),('memory',P),('region',U),('code',P)]
lib=C.CDLL(str(ROOT/'dsp/build/org-resona-demo-time-loom-dsp-host.dylib'))
lib.resona_module_get.restype=C.POINTER(Module)
m=lib.resona_module_get().contents
init=C.CFUNCTYPE(None,P,C.POINTER(Host))(m.init)
reset=C.CFUNCTYPE(None,P)(m.reset)
setp=C.CFUNCTYPE(None,P,U,F)(m.set)
process=C.CFUNCTYPE(None,P,C.POINTER(C.POINTER(F)),C.POINTER(C.POINTER(F)),U)(m.process)
alloc=[C.create_string_buffer(131072+127) for _ in range(2)]
ptrs=[(C.addressof(a)+127)&~127 for a in alloc]
buffers=(Buffer*2)(*[Buffer(i+1,2,131072,ptrs[i]) for i in range(2)])
mem=Memory(1,C.sizeof(Memory),2,buffers)
host=Host(1,48000,256,1,2,b'resona-box',None,C.sizeof(Host),C.pointer(mem),None)
state=C.create_string_buffer(m.state+127);sp=(C.addressof(state)+127)&~127
init(sp,C.byref(host))
counts=[1,17,64,128,256]
def run(signal):
    out=[];o=0;k=0
    while o<len(signal):
        n=min(counts[k%len(counts)],len(signal)-o);k+=1
        a=(F*n)(*signal[o:o+n]);b=(F*n)()
        ip=(C.POINTER(F)*1)(C.cast(a,C.POINTER(F)));op=(C.POINTER(F)*1)(C.cast(b,C.POINTER(F)))
        process(sp,ip,op,n);out.extend(b);o+=n
    return out
def rms(xs): return math.sqrt(sum(x*x for x in xs)/max(1,len(xs)))
def tone(n,f=220): return [.35*math.sin(2*math.pi*f*i/48000)+.09*math.sin(2*math.pi*f*2*i/48000) for i in range(n)]
results={}
dry=tone(33600)
live=run(dry)
results['live_transparency_max_error']=max(abs(a-b) for a,b in zip(live,dry))
assert results['live_transparency_max_error']<1e-6
setp(sp,2,1)
held=run([0.0]*24000)
results['captured_phrase_rms']=rms(held[-6000:])
assert results['captured_phrase_rms']>.02
setp(sp,0,4)
short=run([0.0]*15000)
tail=short[-9000:]
lag=1500-96
results['short_loop_period_error']=rms([tail[i]-tail[i-lag] for i in range(lag,len(tail))])
assert results['short_loop_period_error']<1e-5
setp(sp,4,40);setp(sp,2,0)
release=run([0.0]*96000)
results['release_rms_first_100ms']=rms(release[:4800])
results['release_rms_final_100ms']=rms(release[-4800:])
assert results['release_rms_final_100ms']<results['release_rms_first_100ms']*.002
# A fresh capture uses the bank that kept recording throughout the old hold.
run(tone(32000,330));setp(sp,2,1)
recaptured=run([0.0]*10000)
results['recapture_rms']=rms(recaptured[-6000:]);assert results['recapture_rms']>.02
setp(sp,5,1)
bypass_input=tone(12000,440)
bypass_output=run(bypass_input)
results['bypass_max_error_after_slew']=max(abs(a-b) for a,b in zip(bypass_input[6000:],bypass_output[6000:]))
assert results['bypass_max_error_after_slew']<2e-5
all_output=live+held+short+release+recaptured+bypass_output
results['all_finite']=all(math.isfinite(x) for x in all_output)
results['peak']=max(abs(x) for x in all_output)
assert results['all_finite'] and results['peak']<=1
results['frame_counts_tested']=counts
results['scope']='Host module ABI only; no USB, hardware CPU, analog path or Windows runtime tested.'
(ROOT/'verification').mkdir(exist_ok=True)
(ROOT/'verification/host-dsp.json').write_text(json.dumps(results,indent=2)+'\n')
with wave.open(str(ROOT/'verification/host-capture-unravel.wav'),'wb') as w:
    w.setnchannels(1);w.setsampwidth(2);w.setframerate(48000)
    w.writeframes(b''.join(struct.pack('<h',round(max(-1,min(1,x))*32767)) for x in live+held+short+release))
print(json.dumps(results,indent=2))
