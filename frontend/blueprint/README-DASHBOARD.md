# Dashboard blueprint (Layer 6)

`mockup-source.html` is the approved design. It was built in a Claude design canvas, so its outer markup (`<x-dc>`, `{{holes}}`, `sc-for`/`sc-if`, `class Component extends DCLogic`) is that tool's template syntax. **Do not reuse that wrapper.** Rebuild the UI in React, and lift the *logic* from the `<script>` part:

- Shaders: `GLOBE_VS` / `GLOBE_FS` (terrain displacement + normals from the elevation map, sun lighting, night lights, borders, India coast glow), `SHELL_VS` (overlay shells that follow the terrain), `SUN_VS` / `SUN_FS`, `AIRGLOW_FS`.
- Ephemeris: `EL`, `helio`, `toEq`, `moonEcl`, `sky()`. These are JPL Keplerian elements + a lunar theory, checked against Astropy (planets < 0.1°, Moon < 0.5°). Earth orientation uses GMST, and ECI maps to the scene as (x, z, -y).
- Camera orbit controls (quaternion arcball, roll, zoom-to-cursor), the orthographic `pick()` ray-sphere hit, and lat/lon conversion.
- Layer painters: `paintField` (heat/rain/moisture), pressure isobars + H/L, `paintElev` (hypsometric + 500 m contours), wind particles `stepFlow`, the India-only mask `buildMask`, the hover glow outline `lift`, shock marker `placeMarker`, and the outcome logic.
- **Replace the mockup's placeholder physics** (`propagate`, `shockDelta`, and the `frames.json` real days) with live data from the gateway (`/presets`, `/run`, `/stream`, `/geography`, `/shocks`, `/shock/preview`).

## Textures (`textures/`)
- equirectangular, 8192×4096 / 4096×2048: `earth_day_relief.jpg`, `earth_elevation.png` (0..8000 m → 0..255, land only), `borders.png` (alpha = lines), `india_coast_glow.png`, `earth_night_lights.png`
- India-domain crops (65–101°E, 6–38°N): `india_domain_day.jpg`, `india_domain_elevation.png`
- Sun, Moon, planets, Milky Way, Saturn rings

## Credits (put in README)
- ETOPO1 10-arcmin topography via fatiando-data
- global-land-mask (GLOBE)
- Natural Earth (India point of view)
- DataMeet India states (CC BY 4.0)
- NASA Black Marble night lights (via three-globe example)
- Solar System Scope textures (CC BY 4.0): Sun, Moon, Milky Way
- Stellarium planet textures (GPL; keep the attribution)
- three.js (MIT)

`build-scripts/` regenerates the textures. They expect source downloads in `/tmp/geo`; the URLs are in the scripts.
