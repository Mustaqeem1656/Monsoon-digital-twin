# frontend — 3D dashboard

Vite + React + three.js. Rebuilt from the approved design in `blueprint/mockup-source.html`: its shaders, ephemeris,
camera controls and layer painters live in `src/engine/`, and the UI is in `src/App.jsx`.

All data is live from the gateway (`backend/gateway`, port 8100) — `/presets`, `/run`, `/stream`, `/geography`,
`/shocks`, `/shock/preview`. There is no placeholder physics in the dashboard. Fonts (`@fontsource`) and textures
(`public/textures/`) are bundled, so it works offline.

```bash
cd frontend
npm install
npm run dev            # http://127.0.0.1:5173  (needs serve.py on :8000 and the gateway on :8100)
npm run build          # static build in dist/; serve it with: npm run preview
npm run test:e2e       # browser test against the running stack (uses the installed Edge; BROWSER=chrome to switch)
```

Set `VITE_GATEWAY=http://host:port` if the gateway is not at `http://127.0.0.1:8100`.

| Path | What it is |
|---|---|
| `src/engine/globe.js` | Globe scene, Sun/Moon/planets, controls (arcball, roll, zoom-to-cursor), picking, painters, wind particles, India mask, hover glow, shock marker |
| `src/engine/ephemeris.js`, `src/engine/shaders.js` | Lifted unchanged from the mockup |
| `src/data.js` | Gateway client, layer and shock definitions, gateway-array conversions |
| `src/App.jsx` | Header, readout, layer tiles, time control, shock and outcome panels, timeline |
| `tests/e2e.mjs` | End-to-end browser test (tiles, hover, controls, shock flow) |
| `blueprint/` | Approved mockup, its README and the texture build scripts |
