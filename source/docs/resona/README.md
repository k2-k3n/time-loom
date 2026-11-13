# Resona developer guides

Copied from the Resona SDK into every project (read-only; `resona-lab sdk sync .` refreshes
them with the project's SDK).

| File | For |
| --- | --- |
| [effects.md](effects.md) | effects (algorithm packs): the module API, real-time rules, screens, the UI kit, the Box, DSP helpers, memory, CPU, worked changes, API rules, and the `resona-lab` commands and MCP tools |
| [apps.md](apps.md) | Box Apps: how they run, the platform API by topic, UI libraries, USB/Bluetooth names and the start-up animation, worked changes and API rules |

A preset is the factory chain or one effect. Put an effect on the Box with **Install on Box**
in Creator Lab, or `resona-lab presets import --request '{"preset":N,"path":"build/<id>.rpk","run":true}'`.
