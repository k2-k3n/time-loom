# Time Loom controller

Web (`web/`, the Resona Box website's look) and Mobile (`mobile/`, the Creator Lab app's look)
interfaces for Time Loom. Both draw the controls listed in `shared/profile.js`; everything else is
the shared kit from `_controller_kit/` (refresh it with `python3 _controller_kit/install.py`).

Every control is one MIDI CC on channel 1, so any MIDI controller plays the App too. The App
side is `src/controller_link.h`; the MIDI map is in the App's README.

Preview without a Box: `resona-lab controller preview . --interface web` (or `mobile`), or serve
this folder over HTTP and open `web/index.html?demo=1`.
