# Box Apps

A box app is the Resona Box's application: what the screen shows, what the encoders do, how
presets are browsed, which MIDI messages mean what, the settings pages. The platform (the
closed firmware under it) keeps start-up and recovery, the audio thread and the factory
engines, the effect runtime, storage, and the management channel. The app talks to the platform
only through `resona_platform` in `sdk/include/resona/platform.h`; read that header for the
exact signatures. This guide says how the parts fit together.

Start from a template: `app-factory` is the box's real UI (pages, presets, settings, Global
EQ, Encoder 2 mapping) and the best reference for how the API is used; `app-blank` is the
smallest working app; `app-synth` drives an algorithm pack as an instrument.

## Creator Lab workflow

Use New Project → Box App, choose a template, and edit its C/C++ files in the normal
explorer. Build checks the RV32 package and starts the full interactive device UI preview.
Both encoders, timers, settings and temporary local presets are available. Install builds
and reviews a package, then stores the App (at most 512 KB) on the connected Resona Box and
restarts it. No CLI or OS/bootloader flashing is required; existing presets/models survive.

Preview is a separate host process: crashes/timeouts preserve the editor. Its storage is
local and temporary, its asset library starts empty, and it does not simulate DSP,
model/pack loading, pack screens, transport or threads. Synth Box therefore shows its
missing-pack state locally; test instrument playback on a box with Tiny Synth installed.
The worker has normal host permissions; it is not a security sandbox. Restart/Build resets
local simulation state. Use the real box for hardware/CPU/audio checks.

## How an app runs

```c
static const resona_app kApp = {
    RESONA_PLATFORM_VERSION, sizeof(resona_app),
    "org.example.my-app", "My App", "0.1.0",
    sizeof(State),   /* the platform allocates this, zeroed (at most 64 KiB) */
    64 * 1024,       /* the most you will ask from P->alloc (at most 512 KiB) */
    init, event, frame,
};
const resona_app *resona_app_get(void) { return &kApp; }   /* extern "C" in C++ */
```

- At boot the platform loads the app into memory, runs C++ static constructors, then
  `init(state, platform)`. Keep the `platform` pointer (`P` below). Return 0, or the box starts
  in safe mode.
- `event(state, ev)` gets every event in order: input gestures, MIDI, changes made by
  someone else, timers, audio restarts.
- `frame(state, ms)` runs about 30 times a second: animate and redraw what changed.
- All three run on the app's **main thread**. They must return quickly: no waiting, no long
  loops. Each call may use 200 ms of CPU (`init` 2 s, for building fonts and tables); past
  that the App is stopped and the Box shows the recovery screen. Waiting inside a platform
  call such as `effects_begin` does not count. Use `timer_start` for bounded periodic work (at most8 timers; all32-bit IDs
  are valid). Periods1..2147483647ms; invalid periods return ERR_ARG without
  replacing an existing timer. Exhaustion returns ERR_NO_MEMORY; repeat0 means forever.
  Background threads and RTOS mutexes are unsupported in the protected runtime.
- Apps may use mutable globals and C++ constructors (unlike packs). No exceptions or RTTI.
- The Box ends an App that passes an out-of-range argument to `sleep_ms` (over 50),
  `screen_brightness` (over 100), `input_config` (input over 1, unknown flags), `led_set`
  (over `RESONA_LED_BYPASS`) or `ctrl_send` (over 64 bytes), or a pointer outside its memory.
  Lab's preview stops the App the same way and says why in its log.
- Preset jobs report the codes in `platform.h`, including `RESONA_ERR_FULL`,
  `RESONA_ERR_BUSY`, `RESONA_ERR_CHANGED` and `RESONA_ERR_CANCELLED`;
  `resona_error_string()` names them.
- No C library beyond `resona/libc.h` (memcpy … snprintf). Memory comes from `P->alloc`: power-of-two alignment1..4096, at most64 live allocations on the device; NULL on invalid requests or exhaustion. The byte budget and alignment padding also constrain fit.
- Limits on the Resona Box: App size 512 KB (program and variables, and the App file);
  `state_size` 64 KB (allocate more with `P->alloc`), heap 512 KB, event queue 32
  events (more are dropped), MIDI/SysEx messages up to 256 bytes per event.
  `post()` copies the event and valid MIDI/CTRL payload before returning. Payload
  pointers received by `event()` are valid only during that callback. The queue
  includes an event being dispatched and is shared with platform notifications;
  use an App acknowledgement protocol when reliable delivery matters.

## Safety

- An app that crashes or fails `init` while starting is marked failed; the next boot shows the
  platform's **safe mode** (it says why). Holding **Encoder 1 at power-on** also gives safe
  mode for that boot. Installing a new app always works from safe mode.
- `resona-lab app info` shows what runs and why; `resona-lab app reboot --safe` gives one
  safe-mode boot.

## Screen

320 × 172 pixels, RGB565 (`RESONA_RGB(r, g, b)`).

```c
uint16_t *px; uint32_t stride;
resona_ui *ui = P->screen_begin(&px, &stride);     /* the back buffer */
ui->clear(ui->ctx, RESONA_RGB(10, 12, 18));
ui->text(ui->ctx, 12, 10, 3, RESONA_RGB(255, 160, 0), "HELLO");
px[y * stride + x] = colour;                      /* direct pixels are fine too */
P->screen_present(0, 0, 0, 0);                    /* 0,0,0,0 = the whole screen */
```

`resona_ui` has clear, rect, text (5×7 font, scale 1–8), line, dotline, ellipse,
ellipse_fill, dots, poly, poly_fill (`resona/ui.h` wraps them). Present only the rectangle
you changed when you redraw often (meters): it is cheaper. An RPK effect with its own
screen draws it with `program_effect_screen_draw(effect, force)`; pass encoder events to it with
`program_effect_screen_event`. For richer screens see [UI libraries](#ui-libraries-for-box-apps).

### App-owned fonts and UTF-8

Built-in text is a small5×7 face, with one fallback per unsupported Unicode
scalar. Put your own font assets directly in the App project and draw them
with `<resona/font.h>` / `resona_ui_text_font`. `tools/font.py` converts selected
glyphs from a licensed TTF/OTF into a C header, keeping its notice beside it.
No source TTF, Python or font engine is needed on the Box. Both Apps and block
screens can use the helper; block draw budgets still apply. See the standalone
App-owned Unicode font example. The OS has no LVGL; Apps may supply their own
rendering/layout integration using the framebuffer.

For richer screens, the SDK has two optional libraries an App compiles in: the Box UI widget
kit (`lib/widgets`, about 4 KB) and an LVGL 9 port (`lib/lvgl_port`, about 150 KB). See
[UI libraries](#ui-libraries-for-box-apps).

## Input

Two push-encoders: `RESONA_INPUT_SELECTOR` (Encoder 1, top) and `RESONA_INPUT_CUSTOMIZE`
(Encoder 2, bottom). `RESONA_APP_EV_INPUT` carries a gesture in `ev->u.input`:

| `kind` | meaning |
| --- | --- |
| `RESONA_EVENT_TURN` | `value` = signed detents (+ clockwise) |
| `RESONA_EVENT_CLICK` | a short press (on release, unless press-on-down) |
| `RESONA_EVENT_DOUBLE` | a double press, only if enabled for that encoder |
| `RESONA_EVENT_LONG` | held about 0.6 s |

`P->input_config(input, flags)`: `RESONA_INPUT_DOUBLE` reports double presses (single clicks
then wait about 250 ms); `RESONA_INPUT_PRESS_ON_DOWN` reports a click on press. Raw
press/release arrives as `RESONA_APP_EV_KEY`. The status light: `P->led_set(RESONA_LED_*)` for the standard status modes.

Full RGB is available through `P->rgb_set(&config)` and `P->rgb_get(&state)`:

```cpp
resona_rgb_config c = resona_rgb_solid(255, 30, 80, 128);
c.animation = RESONA_RGB_BREATHE;
c.period_ms = 1800;
P->rgb_set(&c);
```

Check version>=5 and size through rgb_get before reading the tail. Brightness
and colors use linear0..255 intensity. Solid uses period0; other animations
use20..60000ms. Blink/fade use secondary RGB; rainbow ignores base colors; fade
holds the secondary color after one period. NULL releases custom control.
Animation scheduling and PWM are trusted platform services, outside audio.
Do not call these APIs in algorithm process(). A Lab override returns ERR_STATE
to app writes until released; fault recovery restores the standard status light.
See the RGB Studio example for encoder/MIDI control and custom frame sequences.

## The sound: the factory chain or one RPK

A preset is one of two shapes (`resona/program.h`):

- the **factory chain**: the five built-ins Gate, Comp, Resona (`RESONA_ENGINE_AMP`), NAM and
  Cab, each once, in any order. They are closed, visible only through their parameters; or
- **one RPK effect** on its own, from the effect files stored on the Box.

Nothing else: there are no mixed or longer chains, so an RPK never shares the CPU with the
built-ins.

- `program_chain(&view)`: per effect its source, name, on/off, parameter count, model and
  `tripped` (bypassed by its time guard).
- `program_effect_param_info/get/set(effect, index, ...)` in the effect's own units,
  `program_effect_enable` (an RPK preset: that effect, not the preset; `program_enable`
  switches the preset), `program_effect_model(effect, model)` (Resona/NAM/Cab: the model
  number 0..29, `RESONA_ENTRY_INDEX` of the model's entry from `entry_count`/`entry_info`;
  `RESONA_CHAIN_NO_MODEL` until one is chosen), `program_effect_variant` (Gate: 0 gate,
  1 auto gate; changing it clears an Encoder 2 mapping on the Gate).
- `program_effect_screen_draw/event`: an RPK effect that draws its own editor.
- `program_edit(&edit)`: `RESONA_CHAIN_SET` makes the playing preset the factory chain
  (`source` BUILTIN, `engine` 0) or one RPK (`source` RPK, `entry`), at default values;
  `RESONA_CHAIN_MOVE` reorders the factory chain. An edit is a job (poll `program_job`;
  `RESONA_CHANGED_PROGRAM_JOB` tells you when) because the new sound is checked for CPU and
  memory before it plays. Only a bad version, size or op is refused at once; anything else
  the edit cannot do (MOVE on an RPK preset, an unknown entry, a built-in `engine` other
  than 0) ends the job `RESONA_PROGRAM_FAILED` with `RESONA_ERR_ARG`. The job's action is
  `RESONA_PROGRAM_EDIT`. A refusal leaves the playing preset as it was.
- `program_map_encoder(effect, index)`: the parameter Encoder 2 turns; it follows its effect
  when the factory chain is reordered.

Turning a built-in on is admission and can be refused. Edits change the playing preset;
saving is a separate job. An App that wants its own combination of effects builds an App
effect graph instead (below): it owns audio while it runs.

## Presets

50 stored chains (`RESONA_PROGRAM_PRESETS`). `preset_info(slot, &info)` names a slot;
`program_info(&info)` describes what plays now. Loading, browsing and saving are jobs:
`program_submit(RESONA_PROGRAM_LOAD | PREVIEW | SAVE, slot, name, expected_crc32)`, then
`program_job`. PREVIEW plays a slot without making it active (browsing); SAVE captures the
running values. `program_enable(0/1)` switches the whole chain off and on. At boot the
platform restores the active preset before your `init` runs; read it, don't reload it.

## Settings and global audio

`setting_get/set(RESONA_SETTING_*, value)`: VOLUME 0–100, BYPASS, INPUT_GAIN −20…20 dB,
LOOPBACK, USB_VOLUME, BT_ENABLE, BT_VOLUME, MIDI_CHANNEL (0 = omni), BLOCK_FRAMES 64/128/256
(restarts audio; you get `RESONA_APP_EV_AUDIO` when it is back). Global EQ:
`global_eq_get/set` (five bands 100 Hz–4 kHz and a level, in half dB; `persist` 0 while a
control turns, 1 when it is let go). Both enabled and persist must be0or1;
invalid complete requests return ERR_ARG before changing any EQ field. With
persist0, enable changes as well as bands/level are temporary. `meters(&in, &out, &cpu)`: levels 0–9.

## MIDI and SysEx

MIDI reaches the app as `RESONA_APP_EV_MIDI` (`port` USB, BLE or UART; complete
SysEx frames). Messages over256 bytes are dropped whole. Send1..512 bytes with
`P->midi_send(port, data, len)`; invalid scalar length/port returns ERR_ARG without
faulting the App. Inaccessible user buffers remain protected memory faults. SysEx frames that start
`F0 7D 4E 43` are reserved for the platform and never reach the app; anything else is
yours to define.

## Changes made by someone else

`RESONA_APP_EV_CHANGED` with `what` = `RESONA_CHANGED_PRESET` (a preset was recalled, by Lab
or a host), `EFFECT` (on/off, parameters, model or variant), `CHAIN` (the preset's effect was
set, or the factory chain reordered), `PROGRAM_JOB`, `MODELS` (models or effects installed/removed), `GLOBAL`, `WIRELESS`,
`USB`. Re-read what you show and redraw. `RESONA_APP_EV_AUDIO`: audio restarted
(`block_frames`, `sample_rate`) or an effect was bypassed by its time guard.

## Storage

`app_store_read/write(offset, buf, len)`: the app's own bytes (`app_store_size()`, 4 KiB on
the Resona Box), power-safe, kept across reboots and updates of the same app id.
An invalid offset/length, including unsigned overflow, returns `RESONA_ERR_ARG`
and leaves destination/storage unchanged. Empty spans at offset==size are valid
no-ops with a valid non-NULL buffer. The protected device still faults an App
that supplies inaccessible memory for a valid nonempty span. Use
`resona_app_store_range_valid(capacity,offset,length)` for optional caller checks.
Put a magic
number and version at the start and validate on read. Presets, models and settings are
stored by the platform; do not copy them here.

## Not available yet

`ctrl_send` (custom wireless controller packets) returns `RESONA_ERR_UNSUPPORTED`; renaming, recolouring and
deleting models works for some entry kinds only (check the return value).

## Resources

`program_resources(&info)` gives live audio ticks (4 MHz), fast and PSRAM heap capacity/free
bytes and instruction-memory use. The platform measures and admits effects before they play;
treat a refusal as a real resource limit. Built-in memory is reserved by the platform; effect
state never silently falls back to slower RAM. CPU trials are measurements, not a hard
execution-time guarantee; the protected runtime separately contains access faults and stuck
callbacks. Move a project to Lab's SDK with `resona-lab sdk sync`.

## Code-first startup customization

Declare USB product/audio/MIDI names in your Box App code using
`resona/startup_helpers.h` and `resona_startup_usb_apply(platform,&names)`.
Negative returns refuse the change;1 means saved/reboot required;0 means active.
Only call reboot when required, so initialization cannot loop resets. There is
no USB naming window or user-supplied VID/PID. The trusted platform manages
profiles; Creator Lab reconnects through reserved CDC, independent of MIDI names.
Names are 1..47 UTF-8 bytes without control characters.

`startup_splash_set(data,bytes)` installs a validated independent RSP1 animation;
NULL/0 restores the factory splash. Duration0 skips; other durations are chosen
by the author. Use the SDK tools/splash.py tool and [startup](#splash-screens-and-usb-names), or generate
the public format from code. Long splashes delay Box App initialization and preset
recall; USB management remains available. Use resona/splash.h to build frames and resona_startup_splash_apply to stage only changed assets; there is no startup setup window.
Do not put any startup operation in an audio callback. Do not repeatedly write
settings every frame. All startup setters are bounded protected control calls.

The platform has `bluetooth_names_get/set` and `<resona/bluetooth_helpers.h>`. Name changes persist in the wireless controller and require disconnecting all power. No radio address, bond or sample-rate control is exposed.


### Resource-admitted effect graphs

Use `<resona/effects.hpp>` and one `resona::Effects` controller for an App-owned
graph. `begin(platform)` transfers audio ownership (the preset chain is suspended); `factory(engine)` and
`pack(id,version,crc32)` return independent handles. `connect(source,destination,gain,
source_channel,destination_channel)`, `output(handle)` and `capture(handle)` build
routes; `commit()` validates, admits and copies them. `param`, `enable`, `info`,
`param_info` and `status` operate on handles. Check every returned error/zero handle.
Use `clear_routes()` to build a replacement graph. CPU/RAM/code determine the
instance count; ten heavy effects may not fit. USB/Bluetooth sources are stereo,
effects are mono, and summing is explicit. A failed commit retains the old graph.
See [contracts](#app-owned-effect-graphs) for lifetime and preview limits.

An active effect graph may commit a lower/equal mixer reservation even when the
latest platform peak has risen, so routes can be removed before destroying an
instance. First activation and reservation increases still require CPU headroom.

The non-increasing graph admission exception also requires that the new plan
uses only DSP nodes already present in the active plan. Newly activated nodes
retain normal headroom checks, even if their instances are already resident.

Preview and native built-in metadata use the same public descriptor
table, including Auto Gate SENSITIVITY. `effect_param_info.def` stays constant
after control changes. Failed pack creation distinguishes missing ID, version
mismatch, CRC mismatch, ambiguity, malformed stored data and I/O; see the
ERR_PACK_* constants in platform.h. `resona_error_string(rc)` gives a display
label.

## UI libraries for Box Apps

The Resona OS has no UI toolkit: an App draws its 320 x 172 RGB565 frame into the back buffer
from `P->screen_begin` and shows it with `P->screen_present`. A toolkit is a library compiled
into the App, so the App pays for it in size. The SDK offers two, both optional, in `lib/`:

| | `lib/widgets` (Box UI) | `lib/lvgl_port` (LVGL 9) |
| --- | --- | --- |
| Look | the Box's own screens: pixel font, factory palette | LVGL's default theme (dark), Montserrat 14 |
| Widgets | text (scale 1-3), header, value tile, bar, meter, page dots, list, toast, encoder focus | label, button, bar, slider, list, image; more by enabling them |
| App code | about 4 KB (`widgets_demo`: 4.9 KB .rpk) | about 150 KB (`lvgl_demo`: 154 KB .rpk) |
| RAM | none of its own; widget state lives in your State | 40 KB LVGL heap + 15 KB render band from `P->alloc` |
| Language | C (usable from C++) | C (usable from C++) |

An LVGL App is large, so it leaves less room on the Box for effects and models. Prefer Box UI unless you need LVGL's layouts, styles or
animations.

### Using a library

The App build compiles exactly the files listed in `sources` of `resona.project.json`. Library
sources are not part of the pinned SDK (`include/`, `device/`), so list them by path. The
examples in `apps/` reach them inside the SDK folder:

```json
"sources": ["src/app.c", "../../lib/widgets/box_ui.c"]
```

For a project outside the SDK folder, copy `lib/widgets` (or `lib/lvgl_port`, keeping
`lvgl/LICENCE.txt`) into the project, e.g. as `lib/widgets`, and list `lib/widgets/box_ui.c`.

### Box UI (`lib/widgets/box_ui.h`)

```c
boxui_canvas c;
boxui_begin(&c, P);                                   /* back buffer from screen_begin */
boxui_clear(&c, BOXUI_BG);
boxui_header(&c, "AMP", "1/2");
boxui_tile(&c, 8, 40, 98, 104, "GAIN", "+6", "DB", 750, boxui_focus_mode(&s->focus, 0));
boxui_page_dots(&c, 160, 160, 0, 2);
boxui_toast_draw(&c, &s->toast);
boxui_present(&c, P);
```

`boxui_focus_handle(&focus, ev, &delta)` turns encoder events into `BOXUI_MOVED` (E1 turn),
`BOXUI_ADJUST` (E2 turn, or E1 while `focus.editing`), `BOXUI_ACTIVATE` (click) and
`BOXUI_BACK` (E1 long). `boxui_list` scrolls a string list; `boxui_toast` times itself out
with `boxui_toast_tick(&t, ms)` from `frame`. Nothing allocates. Text is the 5x7 ASCII face;
for other scripts use an App-owned font (`resona/font.h`). Example: `apps/widgets_demo`.

### LVGL port (`lib/lvgl_port/lvbox.h`)

```c
static int init(void *s, const resona_platform *P) {
    if (lvbox_init(P, 0) != RESONA_OK) return -1;          /* lv_init, display, encoders */
    lv_obj_t *slider = lv_slider_create(lv_screen_active());
    lv_group_add_obj(lvbox_group(RESONA_INPUT_CUSTOMIZE), slider);   /* E2 turns it */
    lv_list_add_button(lv_list_create(lv_screen_active()), NULL, "Clean"); /* E1 group */
    lvbox_refresh();
    return 0;
}
static void event(void *s, const resona_app_event *ev) { lvbox_event(ev); }
static void frame(void *s, uint32_t ms) { lvbox_frame(); }      /* lv_timer_handler */
```

- Display: partial rendering in 24-row bands; the flush copies each band into the back
  buffer and presents the changed rectangle once per refresh.
- Tick: `P->millis`. Heap: LVGL's builtin TLSF allocator on a pool from `P->alloc`
  (`LV_MEM_SIZE`); set the App's `heap_bytes` to at least `lvbox_heap_bytes(rows)` (64 KB in
  the demo). No C library is needed: LVGL's builtin string and sprintf are used.
- Input: E1 drives the default group (turn = focus, click = press / edit toggle,
  long = `LV_KEY_ESC`); E2 drives a second group kept in edit mode, so its turns change the
  object directly.
- `lv_conf.h` enables only what the demo uses. To add a widget, set its `LV_USE_*` to 1 and
  add its `lvgl/src/widgets/<name>/*.c` (from LVGL 9.2.2) to `sources`; check the .rpk size.
- LVGL is MIT; its Montserrat/Font Awesome bitmap font is SIL OFL 1.1. See
  `THIRD_PARTY_NOTICES.md`.

Example: `apps/lvgl_demo` (its `sources` list is the full LVGL file set the port needs).
Preview either with `resona-lab app preview <project> --out frame.png --event selector:turn:1`.

## Splash screens and USB names

Part of platform API 1; no extra firmware is needed.

### USB names in your code

USB naming is part of the Box App source; there is no naming-settings window.
Use this inside your init callback after retaining the platform pointer:

```cpp
##include <resona/startup_helpers.h>

const resona_usb_names names = {"My Synth", "My Synth Audio", "My Synth MIDI"};
int result = resona_startup_usb_apply(platform, &names);
if (result < 0) return result;
if (result == RESONA_STARTUP_REBOOT_REQUIRED) {
    platform->reboot(); // The same code returns0 after the new profile is active.
}
```

See [USB Names in Code](../../apps/usb_names/src/app.cpp) for a complete project.
The helper compares saved names before writing. Users never enter a VID/PID;
the platform and Lab look after the USB identity.
Pass NULL to restore factory names. Names use1..47 UTF-8 bytes without control
characters. The whole composite device reconnects, so audio/MIDI software may
need its ports selected again. Named profiles and splashes persist independently
of the Box App. Host code cannot assume all software displays a single string:
OS/DAW labels may combine product/interface/jack names or retain user aliases.
The bootloader recovery identity stays fixed. Identification is not authentication.

### Splash screens in your code

Splash configuration also belongs in Box App code; there is no dedicated setup
window. Build frames using resona/splash.h, then call:

```cpp
int result = resona_startup_splash_apply(platform, animation, bytes);
if (result < 0) return result;
if (result == RESONA_STARTUP_REBOOT_REQUIRED) platform->reboot();
```

The helper validates the complete asset and compares its stored size/CRC. It
writes only a change; the same init code returns0 after the asset is installed,
avoiding repeated writes or reboot loops. NULL/0 restores the factory splash.
If applying USB names and a splash together, stage both successfully before
requesting a single reboot. Call these helpers from init/control code, never audio.

See [Splash in Code](../../apps/splash_code/src/app.cpp) for a complete project. Its
make_animation() function draws four moving-bar frames using bounded RGB565 runs.
Edit colors, timing, duration and drawing code, then Build/Install from Lab.
No external asset editor, JSON file, CLI or setup window is required.
The host preview models these settings and shows the App UI; full early-boot
playback is checked by restarting the device.

Saved data is independent of the installed Box App and takes effect next boot.
No presets, models, saved algorithms or Box App storage are erased. Long animations
postpone Box App initialization/preset recall; USB management remains available.
Duration0 skips; positive durations can reach2147483647 ms. At most128 frames
fit in a24KiB asset. The protected early renderer plays validated data, not arbitrary
user drawing callbacks. Invalid stored data falls back to factory behavior.

### Generate from code

Use the standalone standard-library Python tool:

```sh
python3 tools/splash.py assets/startup/pulse.json pulse.rsp
```

The JSON format has duration_ms and frames. Each frame has hold_ms (16..60000),
a background color and optional rects (at most256). Rectangles use integer x/y/w/h
inside320x172 pixels and #RRGGBB colors. Frame data compresses as RGB565 runs;
complex artwork may exceed the asset capacity even with a short duration.
The public binary format is documented in `include/resona/startup.h`. Your own
tools may generate it; Creator Lab and firmware both validate the complete asset.
No Pillow, Qt or firmware source is needed to run the packer.

### Box App API

Check platform version and table size before using startup_info, startup_usb_set
and startup_splash_set. They run as checked control calls, never in audio processing.
USB setters accept names only, assign/reuse a managed profile, and apply next reboot.
A NULL names pointer restores factory naming. Splash data is copied and validated
before committing; NULL/0 restores the built-in animation. Invalid user pointers
fault within the isolated domain; no direct flash/descriptor access is exposed.
See [Startup Studio](../../apps/startup_studio/src/app.cpp) for explicit MIDI-triggered
examples. Preview changes are local to its worker and do not rename a real USB device.

A box keeps a limited number of custom name profiles. Creator Lab gives each one its
USB identity when the names are applied, and refuses when none is free.

Managed Box App installation skips the current splash after verifying the same
unit identity, so a long authored duration does not delay installation verification.
Normal power-up and explicit Restart retain the authored duration. The CLI also
provides `startup skip-splash` for this boot only; it does not change stored assets.

### Bluetooth names in code

Use `<resona/bluetooth_helpers.h>` and declare
`resona_bluetooth_names names={"My Audio","My MIDI"};`.
`resona_bluetooth_apply(platform,&names)` returns0 if active,1 if saved but a
full power cycle is needed, or a negative error. NULL saves product defaults.
Neither helper nor platform automatically restarts Bluetooth or the device.
Enable Bluetooth before applying; if busy/off/unavailable, retry from a later
control event. The portable preview models names locally and never accesses radio hardware.

Names use1..31 audio /1..28 MIDI UTF-8 bytes without control characters.
Both are persisted together; unchanged values do not write flash. Read
`platform->bluetooth_names_get(&info)` to compare `active` and `saved` names.
Lab shows a notice while `power_cycle_required` is true. Disconnect USB-C **and
any9 V supply**, then reconnect. Restarting only the main processor does not apply
these settings. Host Bluetooth name caches may require a refresh/reconnection.
Pairing addresses/keys, MIDI service and recovery identities remain platform owned.
Bluetooth/USB/DSP sample-rate selection is not exposed by this API.

See [Bluetooth Names in Code](../../apps/bluetooth_names/src/app.cpp). Shared automation
uses `resona-lab bluetooth status`, `bluetooth names --audio NAME --midi NAME`
and `bluetooth restore-names`; these are diagnostics, not a separate setup window.

## Recipes for Apps

### Add a page
Keep a `view` variable in your state; give the new page an enum value, a draw function and
an input handler. In `event()`, route `RESONA_APP_EV_INPUT` by view; set a dirty flag and
redraw from `frame()`. In the factory app see `render_ui()` and `handle_input()` in
`src/factory.c`.

### Add a row to Settings (factory app)
Add an id to the `SETTING_*` enum and a name to `g_setting_names`, fill its value in
`format_setting_values()`, and change it in `edit_setting()` with `P->setting_set` (or your
own storage for an app-only setting). The BLOCK SIZE row is a short example.

### Map a MIDI CC
In `event()`, on `RESONA_APP_EV_MIDI` with `data[0] & 0xF0 == 0xB0`, read the controller
(`data[1]`) and value (`data[2]`) and call, for example,
`P->program_effect_param_set(effect, index, value)`, scaling `value` (0..127) into the range
from `P->program_effect_param_info(effect, index, &info)`.

### Remember something across reboots
Keep a small struct with a magic number; read it in `init()` with `app_store_read` (fall back
to defaults when the magic is wrong), write it with `app_store_write` when it changes.

Each: `resona-lab app build .`, then `resona-lab app install .` on a box (if the user wants it
installed), then `resona-lab app info`.

## API contracts for Apps

### Status-light RGB

The platform table has rgb_set/rgb_get. RGB is a Box App/UI-thread facility.

Startup customization (splash, USB names) and the portable splash builders and
apply-on-change helpers are described in [startup](#splash-screens-and-usb-names).

Bluetooth audio/MIDI names are persisted, with active/saved readback and a full-power-cycle
notice. Names are UTF-8, 31/28 bytes; changing them does not change pairing identities,
USB profiles, MIDI services, recovery, or sample-rate policy.

### App-owned effect graphs

`effects.h`/`effects.hpp` give an App its own effect-instance graph. One
`resona::Effects` controller begins App ownership, creates built-in or installed
`.rpk` instances, connects named input buses and commits a graph. Effect count is
limited by admitted CPU, RAM and code. While an App owns audio the preset chain is
suspended. Built-in model indices are zero-based within their engine library; automatic
model selection fails if no compatible asset exists. Instances are mono; USB/Bluetooth
buses retain explicit left/right channels. Connections sum at each destination;
parallel paths are scheduled within the existing audio block. Cycles and duplicate
edges are rejected. Use a delay inside a DSP block for feedback.

Creation is synchronous and may qualify a pack; distribute expensive initialization
across events. Every resident instance reserves resources, including disabled or
unconnected instances. A failed create/commit preserves the current graph. Destroy
requires removing the instance's live routes first. App faults release its graph
and instances; reinstall/reboot starts new state. Stored pack dependencies stay
pinned while resident. Live preset parameter, on/off and mapping writes from Lab are
refused while an App owns audio. Graphs are runtime state; the App reconstructs them on
startup.

The host preview models built-in metadata/control, handles and graph validation.
It does not run private DSP, load stored device packs, or report hardware admission
measurements. Pack creation returns unsupported in preview. Verify audio and CPU
on the device. `resona-lab app effects` and the MCP tools provide read-only
instance/fault/resource telemetry.

### Recoverable App storage ranges

Preview and firmware return `RESONA_ERR_ARG` for invalid
App-storage offsets/lengths, including overflow. Failed reads do not change the
destination and failed writes do not touch storage. A valid non-NULL buffer with
a zero-length span at the end is a successful no-op. Memory-access violations
remain protected App faults.

### App control limits

The device supports power-of-two App allocation alignment1..4096 and64 live
allocations; invalid requests return NULL. Incoming MIDI events are complete
messages of at most256 bytes; larger messages are dropped, never truncated.
Outgoing MIDI accepts1..512 bytes; invalid scalar lengths/ports return ERR_ARG,
with protected pointer checks retained for valid spans. Preview returns the same
scalar errors but does not simulate MIDI transport. Active graph commits with a
non-increasing mixer reservation remain possible after platform overhead rises,
allowing route removal before instance destruction; new/increased reservations
still undergo the normal CPU admission limit.

The non-increasing graph admission exception also requires that the new plan
uses only DSP nodes already present in the active plan. Newly activated nodes
retain normal headroom checks, even if their instances are already resident.

### Events and timers

Timer periods are1..2147483647ms (about24.9days), IDs use all32 bits, and
repeat0 means forever. Invalid periods return ERR_ARG without replacing an
existing timer. Eight live timers are available; a ninth returns ERR_NO_MEMORY.
The firmware samples time after callbacks before checking each timer.

post() copies the event and its valid MIDI/CTRL payload (at most256 bytes) before
returning. Received payloads live only for their callback. The32-entry queue
includes a queued event being dispatched; new posts are dropped when full.
Device delivery shares the queue with other platform events. No reliable-delivery
acknowledgement is implied. Preview owns payloads too, models the64-record
App allocation limit, zeros allocated bytes and returns the same timer errors.

### Character formatting and global EQ

Character formatting honors width and left alignment, including zero characters
and truncated buffers, and returns the full would-have-written length, in the App's
linked snprintf and in P->format.

Global EQ validates the complete request before changing state. enabled and
persist must be0or1; five bands must be-30..30half-dB and level-24..24half-dB.
Invalid arguments return ERR_ARG without changing any EQ field. The shared
resona_global_eq_valid helper is used by preview and native platform code.
Valid persist0 calls change enable, bands and level without saving. Protected
user-buffer checks still apply; this does not permit invalid pointers.

### UTF-8, App fonts and closed circles

Built-in text decodes UTF-8 scalars and uses one small fallback glyph for each
unsupported scalar. Text byte budgets remain; truncation keeps complete scalar
boundaries. Malformed input uses replacement scalars. The text-width helper
counts the same scalars, in native and preview renderers alike.

Exact+/-360-degree dot sweeps exclude the repeated endpoint (count positions
spaced by sweep/count); partial arcs retain both endpoints. This does not
prevent pixel overlap at small radii/large dot sizes.

Apps and block projects can carry their own 1-bit Unicode glyph assets and use
resona/font.h. See the [App-owned Unicode font example](../../apps/unicode_font/src/app.cpp).
The helper uses existing public primitives and needs no OS font installation. Font assets count toward the normal project budgets; block
screens retain their draw-call limit. The optional local TTF/OTF converter uses
Pillow for authoring only and copies the supplied font notice. Complex shaping/bidi
and LVGL (`lib/lvgl_port`) are App-owned; the OS has no LVGL.

### Built-in metadata and package selection

Factory metadata is a shared public contract recorded through SDK getters,
including all22parameters across five engines and Auto Gate. Preview keeps
the selected Gate variant and reports the same names, defaults, ranges, step
and flags as native metadata. Parameter writes do not change default metadata.

The firmware resolves installed algorithm ID, optional version, then
optional full-RPK CRC. Empty IDs/malformed descriptors return ERR_ARG; missing
ID returns ERR_PACK_ID(-10), unavailable requested version ERR_PACK_VERSION(-11),
CRC mismatch ERR_PACK_CRC(-12), multiple matches ERR_PACK_AMBIGUOUS(-13), and
invalid stored packages ERR_PACK_FORMAT(-14), and a package built for another
target ERR_PACK_TARGET(-15). Actual storage read/list failures
remain ERR_STORAGE(-4). Verified matches remain usable when unrelated entries
are unreadable; without a match, an incomplete scan reports its storage/format
error instead of claiming an ID is absent. No mutation/pinning/processor
activation occurs during selection. Failed creation leaves output handle0 and
the live graph intact. CPU/memory admission still follows successful selection.

Use resona_error_string(rc) for a short description or switch on the constants
for App-local translations. Preview does not load installed packs or simulate
built-in DSP; valid pack creation remains unsupported there.

A stored package built for another target is listed but never run, and does not count as a
match. Pinning a full-RPK CRC selects one of multiple compatible versions/
files without replacing shared stored entries.

### App memory banks

The platform table has `memory_reserve`, `memory_alloc` and `memory_info`.

`LARGE` keeps the existing `heap_bytes` budget and `alloc(bytes, align)` behavior.
An App explicitly reserves a budget before allocating `FAST` or `REALTIME`.
FAST is suitable for ordinary processing work; the smaller REALTIME bank is for
latency-sensitive data. A request stays in the selected bank or fails. There is
no hidden fallback, fixed slot partition, or permanent unused factory reserve.
Release engines the App does not need before claiming their free memory.

`memory_reserve(bank, bytes)` reserves one owned arena. FAST rounds the physical
span to a power of two; REALTIME rounds to128 bytes. `memory_info` distinguishes
the allocation budget, bytes in use, physical span, and unowned device memory.
Available/largest-free are snapshots, before allocation alignment, not promises.
Largest-free is a nonblocking lower bound and may be zero while a heap is busy.
Reserved bytes describe the owned mapped span; global free memory additionally
charges allocator alignment padding and bookkeeping, which can be substantial.
An empty bank must be released with a zero budget before changing its size;
resizing/releasing a bank with live allocations returns `ERR_STATE`. `free`
accepts allocations from every bank. All banks share the64-record limit and
maximum4096-byte power-of-two alignment. Zero bytes, invalid banks/alignments,
and exhausted quotas return recoverable errors or NULL. Foreign frees and
access after arena release remain fatal memory-protection violations.

An App can reach only its own memory. Its state, large heap, framebuffer and stack are
reserved together and rounded up, so an App may take more memory than the sum of their
sizes; the extra belongs to that App.
Banks are released after an App fault and at reboot/unload. Platform reserves,
factory private memory, graph admission and audio deadline checks still apply.

The desktop preview validates bank ownership, budgets, alignment, record limits,
and release/reuse. It reports zero for unowned physical capacities because it
cannot predict live board memory or reproduce device memory-protection faults.
It does not measure bank speed or device CPU usage.
