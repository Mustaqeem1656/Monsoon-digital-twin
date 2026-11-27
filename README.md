# Monsoon Digital Twin — Track 2 "Multiverse of Monsoon"

## For reviewers (5 minutes)

Tested as written on a fresh clone from GitHub, in a new Python 3.12 venv, CPU only. Run everything from the repo root.

**a. Install** (CPU-only torch; the organisers' `monsoon_r1` kit is needed only for the validator and the local grader)
```bash
python -m venv .venv
source .venv/bin/activate        # Windows PowerShell: .venv\Scripts\activate
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install numpy scipy xarray netCDF4 fastapi uvicorn "git+https://github.com/OfficialAbhinavSingh/yug-monsoon-kit"
```
Copy the kit's `india_climate_train.nc` and `stats.json` into `data/` (git-ignored; the grader and the gateway read
them, `serve.py` does not).

**b. Inference server** (terminal 1; `/health` says `"ready"` after about 6 s)
```bash
python serve.py --port 8000
```

**c. Validator and local grader** (terminal 2, same venv)
```bash
python -m monsoon_r1.schema_validator http://localhost:8000
python -m backend.eval.local_grader --url http://127.0.0.1:8000
```
Expected (takes a few minutes): the validator ends with `RESULT: all checks passed`. The grader's scorecard shows
subtotal 68.1 / 70 and `HARD GATE: PASS`, and its repo-scan block shows points 15.0 / 15 (anti-cheat 8.0 / 8).
Our full output: [results/local_grader.txt](results/local_grader.txt).

**d. Gateway and dashboard** (needs Node.js 18+; keep `serve.py` running)
```bash
python -m backend.gateway.app                 # terminal 2: gateway on http://127.0.0.1:8100
cd frontend && npm ci && npm run dev          # terminal 3: dashboard on http://127.0.0.1:5173
```

A fast, physics-aware digital twin of India's daily weather, built for Yugaantar DevForge Track 2.

**Brief (2 pages): [brief/brief.pdf](brief/brief.pdf)** · **Evidence: [RESULTS.md](RESULTS.md)** (grader, validator, repo
scan, data check, timing, training log, ablations) · **Rules: [Rules compliance](#rules-compliance)**

- **Timeline Prime**: give it 3 consecutive days of weather and it rolls forward day by day (10+ steps) without
  exploding or blurring.
- **Multiverse**: add a localized shock (e.g. a warmer Bay of Bengal, a stalled Arabian Sea monsoon flow) and watch
  the response ripple outward across India at a physically plausible speed.

The model works on a 32 × 36 grid of 1° cells (lat 6.5–37.5 °N, lon 65.5–100.5 °E) with 6 daily channels:
`t2m` (K), `tp` (mm/day), `u10`, `v10` (m/s), `msl` (Pa), `tcwv` (kg/m²). All I/O is in physical units.

## Repo map

```
serve.py      inference server the judge runs (/health, /simulate); nothing else
training/     training code (train.py) and every setting (config.yaml); writes backend/weights/
backend/      model + runtime, weights (plain git), eval (baselines, local grader), gateway (dashboard backend), tools
frontend/     3D dashboard (Vite + React + three.js); talks only to the gateway
results/      raw evidence files behind RESULTS.md
brief/        2-page brief (PDF)
README.md     this file
RESULTS.md    measured results, each with the command that produced it
CLAUDE.md     working notes for the coding assistant used during the hackathon
.gitignore    keeps data/, cache/, venvs and node_modules out of git
```

Key files:

| Path | What it is |
|---|---|
| `serve.py` | The inference server the judge runs (FastAPI + uvicorn). Nothing else. |
| `backend/model/net.py` | The network: a small, fully convolutional residual one-day stepper. |
| `backend/model/runtime.py` | Inference engine used by the server: numpy rollout loop, torch or ONNX backend, safety net. |
| `backend/model/inference.py` | Torch-only `simulate()` helper used by training and evaluation. |
| `training/train.py`, `training/config.yaml` | Training code and every tunable setting (commented). |
| `backend/eval/baselines.py` | Persistence and day-of-year climatology (training years only). |
| `backend/eval/local_grader.py` | Local copy of the judge, built on the official `monsoon_r1.scoring`. |
| `backend/eval/impulse.py` | Impulse test: poke one cell, measure how far the response travels per day. |
| `backend/tools/explore.py` | One-off data exploration and plots (laptop only). |
| `backend/tools/export_onnx.py` | Exports `model.pt` → `model.onnx` and checks both give the same output. |
| `backend/weights/` | `model.pt`, `model.onnx` (plain git, about 2 MB each; organisers require no Git LFS), `norm.json` (normalisation constants + model name). |
| `backend/gateway/` | Dashboard backend (FastAPI, port 8100): presets, shock builder, Prime vs Branch runs, impacts. Talks to `serve.py` over HTTP only. |
| `frontend/` | 3D dashboard (Vite + React + three.js). Talks only to the gateway; kept separate from the server. |

`data/` (the organisers' training archive) is git-ignored and never committed. Caches go in git-ignored `cache/`.

## How to run

```bash
python serve.py --port 8000                                  # listens on 0.0.0.0
python -m monsoon_r1.schema_validator http://localhost:8000  # from the organisers' kit
```

- `POST /health` returns `{"status": "ready", "model_name": ...}` only after the model is loaded and warmed up
  (about 6 s); before that it returns 503 `"loading"`.
- `POST /simulate` with `{"init_states": [3,6,32,36], "doy_sincos": [sin, cos], "steps": N, "perturbation": null | [6,32,36]}`
  returns `{"rollout": [N,6,32,36], "inference_ms": ...}`. `steps` can be any positive integer.

Server dependencies are only: torch (CPU) or onnxruntime, numpy, fastapi, uvicorn, and the standard library. It runs on
CPU with 4 threads and writes nothing to disk. Peak memory during a full grader run is 243 MB with the CPU-only torch
build and 598 MB with the CUDA build of torch (both measured, see [RESULTS.md](RESULTS.md#timing-and-memory)).

## How to train

```powershell
python -m venv .venv
.venv\Scripts\activate
# GPU PyTorch (RTX 50xx / Blackwell needs CUDA 12.8+ wheels; pick the index matching your Python version):
pip install torch --index-url https://download.pytorch.org/whl/cu128    # we used cu132 on Python 3.15
pip install numpy scipy xarray netCDF4 fastapi uvicorn pyyaml requests matplotlib onnx
pip install <organisers' monsoon_r1 kit>
# put india_climate_train.nc and stats.json in data/
python training/train.py                       # full run, 45.3 min on an RTX 5050 laptop GPU
python training/train.py --smoke               # 1 epoch per stage, 3 batches: proves the pipeline works
python backend/tools/export_onnx.py                    # refresh backend/weights/model.onnx after retraining
```

All settings are in `training/config.yaml`, with a plain-language comment on each line: model width and depth, epochs
per stage, learning rates, batch sizes, rollout lengths, loss weights, input noise, seed.

Training runs in two stages, with 2005–2018 used for training and 2019–2021 for validation:
1. **Stage A**: predict 1 day ahead.
2. **Stage B**: autoregressive fine-tuning on 2-, 4- and 8-day rollouts, with backprop through the whole rollout, so
   the model learns to stay stable on its own outputs.

The loss is latitude-weighted MSE in normalised units, with heavy-rain cells (> 10 mm/day) upweighted 5×. A spatial
variance-matching (anti-blur) term is added on top. The best checkpoint, by 8-day validation error, is saved to
`backend/weights/model.pt` (45.3 min in total on the laptop GPU, from the training log in RESULTS.md). When training ends, the impulse test, the full local grader and the repo scan run automatically.

## How to evaluate

```bash
python -m backend.eval.local_grader --url http://127.0.0.1:8000         # end to end over HTTP, exactly like the judge
python -m backend.eval.local_grader --model backend.eval.baselines:persistence  # call any Python function directly (fast)
python -m backend.eval.local_grader --model backend.model.inference:simulate
python -m backend.eval.local_grader --list-windows                      # show the chosen test windows
python -m backend.eval.impulse                                          # locality / speed-limit check
```

The grader picks test windows from the validation years 2019–2021 using simple data rules that mimic the hidden
cases:
- monsoon onset
- a heavy-rain spell
- a pre-monsoon heatwave
- a Bay of Bengal low
- a winter western disturbance

That gives one window per event type per year, plus 20 random windows. It also runs the 3 official shocks
(`warm_ocean`, `monsoon_stall`, `null`) and the official causality checks. It prints:
- RMSE per channel at days 1, 4 and 8 against persistence and climatology
- the estimated points for each part
- the hard gate
- time per call
- the judge's repo scan, run on the tracked files

## Gateway (dashboard backend)

Setup: put the organisers' kit data (`india_climate_train.nc`, `stats.json`) in `data/`. On first start the gateway
builds its 6 presets and the climatology from that file into the git-ignored `cache/gateway/` folder (a few seconds).
If the file is missing, it stops with a message telling you to download the kit data.

```bash
python serve.py --port 8000        # inference server
python -m backend.gateway.app              # gateway on http://127.0.0.1:8100 (settings in backend/gateway/config.json)
python -m backend.gateway.presets_builder --force   # optional: rebuild the cache by hand
python -m backend.gateway.test_gateway     # end-to-end test of every endpoint and shock type
```

The gateway never runs the model itself. It calls the inference server over HTTP; the address and endpoint paths
are set in `backend/gateway/config.json`.

| Endpoint | What it does |
|---|---|
| `GET /health` | Gateway status, and whether the inference server is ready |
| `GET /presets`, `GET /presets/{id}` | Six start windows, built at startup from `data/` (onset, heavy rain, heatwave, Bay of Bengal low, western disturbance, quiet): the 3 input days plus the 10 real days that followed |
| `GET /geography` | Model grid, land mask, orography, and a 0.05° state/country raster (RLE) with names |
| `GET /events`, `POST /event/preview` | The 5 weather events (real date, centre, signature); build one at any centre and strength and get its warnings, without running the model |
| `GET /shocks`, `POST /shock/preview` | The 4 shocks; build one and see its size in std units, without running the model |
| `POST /impact` | Impact KPI tiles for the plain forecast or one shock/event: value, delta, level, top states, day 0-10 series, ensemble confidence (16 live calls, < 5 s) and a template explanation |
| `POST /run` | Prime (no shock) and Branch (shock) rollouts, their difference, an outcome per day (day 0 to 10), impacts, and the day the shock fades |
| `WS /stream` | The same as `/run`, sent day by day for the animation |

**Weather events** (`GET /events`, `POST /event/preview`, and `event` in `/run` / `/stream`). There are five real
events from the validation years 2019–2021: monsoon onset, heavy rain, heatwave, cyclone (Amphan, 19 May 2020) and
western disturbance. At startup the gateway finds each event's peak day and centre in `data/india_climate_train.nc`
and cuts out its *anomaly* (the peak day minus the 2005–2018 day-of-year climatology) for all six channels, within
8 cells of the centre, tapered smoothly to zero. The result goes into the git-ignored `cache/`; nothing is committed.
An event can be:
- moved to any centre inside 6–38 °N, 65–101 °E
- scaled from 50 % to 150 % (0 % gives a difference of exactly 0)
- run like a shock, as a plain forecast versus a forecast with the event

The gateway warns, without blocking, about unrealistic choices:
- a cyclone over land
- an onset away from the south-west coast
- a western disturbance south of 25 °N
- a heatwave over sea
- any strength above 120 %

Each event also returns its own results:
- **Cyclone:** daily track, lowest pressure, strongest wind, and a plain statement when the vortex weakens or loses its
  round shape.
- **Heavy rain:** 3-day totals and IMD categories.
- **Heatwave:** heat-stress area, hottest states and how long it persists.
- **Monsoon onset:** how far north the rain reaches.
- **Western disturbance:** rain and temperature change over J&K/Ladakh, Himachal, Uttarakhand and Punjab.

**Shocks** (`GET /shocks`, `POST /shock/preview`). There are exactly four:
- `judge_warm` (Warm Bay of Bengal) and `judge_stall` (Weaker Arabian Sea winds), identical to the kit's `make_shock`
- `zero`, which adds nothing and must give a difference of exactly 0
- `custom`: one variable, an amount, a size and a centre, with a Gaussian footprint

Only one event or shock runs at a time.
A shock larger than 3 std in any channel returns a warning.

**Outcome.** A cell counts as *affected* when any variable changes by at least a physical threshold, set in
`backend/gateway/config.json`: t2m 0.5 °C, rain 2 mm/day, wind speed 0.5 m/s, pressure 1 hPa, moisture 2 kg/m².
For each day, the outcome reports the area, how far the change reached from the centre, the peak change of the main
variable and the most-affected states. If every change later drops below the thresholds, `fade.faded_by_day` says so,
and the dashboard shows "shock faded by day +N". Check a shock day by day with
`python backend/tools/outcome_diagnostic.py`.

**Impact indicators** (rules documented in `backend/gateway/impact.py`; screening proxies, *not* official warnings). Each
returns Prime, Branch and the difference:
- heat-stress index (daily-mean t2m vs the training-years climatology; not an IMD heatwave warning)
- IMD rain categories (moderate, heavy 64.5, very heavy 115.6, extremely heavy 204.5 mm/day) plus 3-day totals
- June–September crop-water stress (rain deficit vs climatology, with India land as the cropland proxy)
- solar proxy (rain-free, low-moisture days)
- wind-power proxy (10 m speed cubed)

**Impact dashboard** (`POST /impact`). Five tiles, each with a Low/Moderate/High/Severe level and documented thresholds:
flood risk (IMD category of the wettest cell; Moderate 15.6, High 64.5, Severe 115.6 mm/day), heat stress (anomaly
3 / 5 K, Severe when the hot cell also averages 35 °C or more), crop-water stress (June–September: share of cropland with
a rain deficit of 50% or more), solar (share of clear, dry land; the level is solar *loss*) and wind power (speed cubed).
River cascade and snowmelt routing are not built, so they are not reported.
- *Confidence*: `backend/gateway/ensemble.py` nudges the start state with small, smooth, seeded noise and sends every
  member to `/simulate` live: 16 members for the plain forecast, or 8 members run both without and with the change
  (16 calls; `serve.py` answers one call at a time, so 16 calls is the < 5 s budget; 1.6–2.7 s on the laptop depending on load, timed by `backend/gateway/test_gateway.py`).
- *Explanations*: `backend/gateway/explain.py`, fixed sentence templates (no language model). Every number in the text is
  taken from the API response, and `test_gateway` checks this.
- *Clouds layer*: a **cloud proxy from moisture and rain** (the model has no cloud channel). It combines the moisture
  anomaly against the 3 start days with the rain rate (formula in `frontend/src/data.js`), drawn as drifting clouds on a shell
  just above the surface.

No weather data is committed. `backend/gateway/presets/presets.json` holds only preset names, descriptions and selection
rules; the windows themselves and the pentad climatology are computed at startup from `data/` into `cache/`.

## Visualization

A 3D Earth centred on India with terrain relief, independent map-layer tiles (Terrain, Elevation, Borders, Heat, Rain,
Wind, Pressure, Moisture, City lights), and weather drawn over India and the nearby seas only. Everything is live from
the gateway; fonts and textures are bundled, so it works offline.

- **Header**, with three buttons:
  - **Earth**: choose the start data (6 real start states) or go *Back to Earth*.
  - **Weather events**: 5 event cards, a strength slider from 50 to 150 %, a drop pointer sized to the event,
    *Where it really happened*, live plausibility warnings, and Run.
  - **Shocks**: the 4 shocks. The judge boxes are drawn on the globe, and Zero shock shows *difference: exactly 0*.
- **Outcome panel**, the single place for results while something runs:
  - a *With it / Difference / Without* switch
  - the six core values at the centre and averaged over the affected area (with / without / Δ)
  - km reached, area, peak change and top states
  - the event-specific numbers, and a *faded by day +N* note
  - cyclone tracks drawn on the globe
- **Current conditions** (top left, when nothing runs): place, lat/lon and the six values under the pointer, for the
  selected day.
- **Layers on run:** layers switch on automatically to suit what runs, and are never switched off.
- **Sky:** the Sun, Moon, planets and day/night follow the scenario date (the start preset plus the timeline day), at
  Noon, Dusk or Night. *Today (sky only)* shows today's real sky; the weather is never live. The Moon is drawn close
  (12 Earth radii) so it is visible. It is decoration only.

```bash
python serve.py --port 8000          # 1. model server
python -m backend.gateway.app        # 2. gateway (port 8100)
cd frontend && npm install && npm run dev    # 3. dashboard at http://127.0.0.1:5173
npm run test:e2e                     # optional: browser test (header, panels, events, shocks, sky, tiles)
python backend/tools/verify_data.py  # data-accuracy check: dataset vs gateway vs dashboard readout (needs all three running)
```

## Model design

- **Inputs (26 maps)**:
  - the last 3 days × 6 channels, normalised (rain as `log1p`)
  - land–sea mask and normalised orography (bundled in the checkpoint: fixed geography, not past weather)
  - day-of-year sin/cos of the day being predicted
  - latitude and longitude coordinate planes
- **Architecture**: a 3×3 conv stem, 3 residual blocks (two 3×3 convs each) and a 1×1 head, width 96.
  **About 521k trainable parameters** (520,998; `sum(p.numel() for p in model.parameters())`, printed by `training/train.py`), 2.1 MB.
- **Residual rollout**: `next_state = current_state + network(inputs)`, applied day by day on the model's own outputs.
  The head starts at zero, so an untrained model is exactly persistence.
- **Local by construction**: the receptive field is **7 cells per day** (the judge's speed limit is 8). It uses
  per-cell LayerNorm instead of Batch/GroupNorm, because those average over the whole map and would teleport a shock
  everywhere at once.
- **Rain in log space** inside the model, and always ≥ 0 at the output. Temperature is clamped to a valid range, and
  moisture is ≥ 0.
- **Deterministic**: no dropout or sampling at inference, so a zero perturbation gives bit-identical output.
- **Speed**: a 10-step rollout over HTTP takes 0.11–0.35 s on CPU (limit 5 s), timed by `backend/eval/local_grader.py`.

## How we prevent drift and blur

Each item names the file that does it.
- **Residual, zero-initialised step** (`backend/model/net.py`): `next = current + network(inputs)`. The head starts at
  zero, so training starts from persistence and only learns corrections.
- **Trained on its own outputs** (`training/train.py`, `training/config.yaml` `stage_b`): after one-day training
  (stage A, 30 epochs) the model is fine-tuned on 2-, 4- and 8-day rollouts (6/6/8 epochs). Gradients flow through the
  whole rollout, so errors that build up over days are penalised directly. This is what stops drift.
- **Anti-blur loss term** (`training/train.py` `loss_fn`): squared log-ratio between the predicted and true spatial
  variance of every map, in physical units / std, which is what the judge's anti-blur check measures. MSE alone rewards
  smooth, blurry maps; this term penalises losing variance.
- **Heavy-rain weighting** (`loss_fn`, `rain_heavy_weight`): cells with real rain above the threshold weigh more, so the
  model does not shrink rain toward the mean.
- **Rain in log1p space**, rain ≥ 0, t2m clamped to the valid range, tcwv ≥ 0 at every step (`backend/model/net.py`,
  `backend/model/runtime.py`): values can't run away.
- **Input noise 0.02 std while training** (`config.yaml` `input_noise`): makes the step robust to its own small errors.
- **Local operators only**: per-cell LayerNorm (no batch/group norm), receptive field 7 cells/day, so a shock spreads
  at a bounded speed instead of leaking everywhere.
- **Measured** (local grader, see [RESULTS.md](RESULTS.md)): day-8 spatial variance is 61–98 % of the real variance
  per channel, inside the judge's 40–250 % band (anti-blur 10/10), and 10-step rollouts stay finite and in range on every window.

## Results

Full, current evidence is in [RESULTS.md](RESULTS.md) and [results/](results/). The table below is a summary.

Measured with `python -m backend.eval.local_grader --url http://127.0.0.1:8000` over HTTP against `serve.py`, in a fresh
Python 3.12 venv with CPU-only torch and only the allowed libraries, on a clean clone of `main`. Validation years
2019–2021, 35 windows. Full output: [results/local_grader.txt](results/local_grader.txt).

| Part | Estimate | Notes |
|---|---|---|
| Forecast skill (RMSE vs best of persistence/climatology) | **30.0 / 30** | mean skill +0.131 (full marks at +0.12) |
| Heavy-rain CSI at 10 mm/day | **15.0 / 15** | mean CSI skill +0.147 (full marks at +0.10) |
| Anti-blur (day-8 spatial variance) | **10.0 / 10** | 61–98 % of the real variance per channel |
| Shock causality | **13.1 / 15** | both shocks localised and stable; outward spread not always strong enough |
| Hard gate | **PASS** | beats persistence at day 4, all outputs valid, localised shock response |
| Repo scan (`monsoon_r1.repo_scan`, run by the grader) | **15 / 15** | anti-cheat 8 / 8, code health 7 / 7, no flags |

Skill against the better baseline, by lead day (range over the 6 channels, `SS` rows of the same grader output):

| Lead | Skill vs better baseline |
|---|---|
| Day 1 | +23 % to +33 % |
| Day 4 | +6 % to +16 % |
| Day 8 | about level with climatology |

## Torch → ONNX fallback

The server prefers `backend/weights/model.pt` with torch. If torch is missing or the checkpoint will not load (for example
because of a version mismatch), it falls back to `backend/weights/model.onnx` (opset 17) through onnxruntime. Both backends run
the same network step inside the same numpy rollout loop.

`backend/tools/export_onnx.py` checks that the two agree: the maximum difference over a 10-step rollout is 1.5e-5 std. Run
`python backend/tools/export_onnx.py --check` in an environment that has onnxruntime. We tested the fallback by starting the
server with torch blocked; it served correctly and passed the schema validator.

## Limitations & what we tried

- **1° grid**: 1° cells cannot resolve cyclone cores, orographic rain bands or city-scale heat.
- **Daily means**: temperature and the other channels are daily averages, so day–night extremes (e.g. heatwave
  maximum temperatures) are not modelled directly.
- **Scores measured on 2019–2021**: the same years were used to pick the best checkpoint, so they are slightly
  optimistic. The judge's hidden cases are from later years.
- **Skill fades with lead time**: beyond about a week, skill is close to climatology.
- **Stationary cyclones**: a 1° grid can't hold a tight vortex, so placed cyclones are smoothed. The model fills the
  low over a few days and does not move it along a track; the outcome panel says so.
- **Fixed 8° event core window**: weather events are cut out within 8 cells of their centre and tapered to zero
  (`backend/gateway/events.py`). Larger systems are truncated at that radius.
- **Deterministic model**: one start state gives one forecast (needed for the judge's null-shock check). The
  confidence shown on the impact tiles comes from an ensemble of 16 live `/simulate` calls with seeded nudges to the
  start state (`backend/gateway/ensemble.py`), not from the model itself.
- **Weather events are anomaly templates**: a real event's pattern is moved and scaled. It is not a new physically
  balanced storm, so unrealistic placements (flagged by the warnings) give less reliable results.
- **Rain extremes are underpredicted**: the model rarely forecasts more than about 50 mm/day in a 1° cell, while real
  events reach 250 mm/day. IMD heavy-rain categories are therefore usually empty in forecasts.
- **Tried and rejected — fine-tune ablations**: short fine-tunes of the shipped weights (loss and noise variants,
  checkpoint averaging) only traded forecast skill against causality; none was adopted
  ([results/tweaks_ablation.md](results/tweaks_ablation.md)).
- **Tried and rejected — bigdata retrain** (branch `tweaks`, not merged): a from-scratch retrain on more years
  (1995–2004 and 2022 added to 2005–2018) scored better on the 2019–2020 tune windows, but on held-out 2021 it scored
  66.99 / 70 against 68.11 for the shipped model, with lower heavy-rain CSI skill (+0.095 vs +0.101) and causality
  (12.75 vs 13.50). The shipped weights are unchanged.

## Impact use case

The dashboard turns each live forecast into five impact tiles: **flood risk**, **heat stress**, **crop-water stress**
(June–September), **solar** and **wind power**. Each tile shows the value on the plain forecast, the value with a shock
or event, the Δ, a level (Low/Moderate/High/Severe), the most affected states and a day 0–10 sparkline. Rules and
thresholds are in `backend/gateway/impact.py`.
- Heat stress is in °C above the normal for the date. Solar and crop-water stress are judged against the normal for
  the same dates (training-years normals, built at startup from the kit file into the git-ignored `cache/`). Wind power
  is in W/m² (0.5 · 1.225 · v³) and as a % of normal.
- **Confidence** (`backend/gateway/ensemble.py`): 16 live `/simulate` calls with small seeded nudges to the start state,
  < 5 s in total. The tile shows the share of members that agree on the level or direction.
- **Explanation** (`backend/gateway/explain.py`): fixed sentence templates, no language model. Every number in the text
  comes from the API response, and `backend/gateway/test_gateway.py` checks this.
- Example: a heatwave event over Madhya Pradesh raises heat stress from Moderate to High. The text names Madhya
  Pradesh, Maharashtra and Uttar Pradesh, temperature as the driver, and 8 of 8 members agreeing.
These are screening proxies for planning and teaching, not official IMD warnings.

## Rules compliance

| Rule | Evidence |
|---|---|
| `serve.py` at the repo root, listens on 0.0.0.0 | `serve.py` (`uvicorn.run(app, host="0.0.0.0", ...)`); `/health` + `/simulate` per the kit contract |
| Allowed libraries only at judging | `serve.py`, `backend/model/runtime.py` import only numpy, torch (CPU) / onnxruntime fallback, fastapi, uvicorn + stdlib |
| Writes only to /tmp (repo read-only) | `serve.py` and `backend/model/runtime.py` open no file for writing; weights are only read from `backend/weights/` (`runtime.py` loader) |
| Offline, no weather APIs anywhere (frontend included) | `git grep` for open-meteo, openweathermap, weatherapi, cdsapi, ERA5/WeatherBench buckets, etc.: no matches in code ([results/repo_scan.json](results/repo_scan.json), [RESULTS.md](RESULTS.md#offline-check)) |
| No hard-coded dates or lookup tables in inference code | judge's `monsoon_r1.repo_scan`: anti-cheat 8/8, no flags ([results/repo_scan.json](results/repo_scan.json)) |
| No past-weather archives in git | presets, climatology and normals are built at runtime from the kit's `data/india_climate_train.nc` into git-ignored `cache/` (`backend/gateway/presets_builder.py` `build()`); `data/` and `cache/` are in `.gitignore`; tracked files listed in [results/tracked_files.txt](results/tracked_files.txt) (only fixed geography: land mask, orography, state raster) |
| Training code at the repo root | `training/train.py` (`main()`: stage A + stage B, saves `backend/weights/model.pt`), `training/config.yaml`; log summary in [RESULTS.md](RESULTS.md#training-log) |
| Weights in the repo as plain git files (no LFS), < 2 GB | `backend/weights/model.pt` (2,112,744 bytes), `model.onnx` (2,138,346 bytes), `norm.json`; no `.gitattributes` / LFS |
| Dashboard separate from the server | `frontend/` (Vite app) → `backend/gateway/app.py` (port 8100) → HTTP → `serve.py`; the gateway never loads the model |
| Dashboard driven live by `/simulate` | `backend/gateway/app.py` `run_model()` posts every rollout to the inference server; `ensemble.confidence()` calls it 16× |
| All work created during the hackathon | git history of this repo (first commit to now) |

## Credits

- **ERA5**: Contains modified Copernicus Climate Change Service information (ERA5, ECMWF); via Google Research WeatherBench 2.
- **Training data**: the organisers' dataset (`india_climate_train.nc`, derived from ERA5) and the `monsoon_r1` kit
  (API contract, scoring, schema validator, repo scan). Neither is redistributed in this repo.
- **Region raster** (`backend/gateway/static/regions.json`, built by `backend/tools/build_geography.py`):
  - Indian state boundaries from [DataMeet](https://github.com/datameet/maps) (CC BY 4.0)
  - neighbouring countries from [Natural Earth](https://www.naturalearthdata.com/) admin-0, India point of view
    (public domain)
- **Elevation grid** (`backend/gateway/static/elevation.json`, built by `backend/tools/build_elevation.py`): ETOPO1
  10-arcmin topography via fatiando-data.
- **Dashboard textures** (`frontend/public/textures/`, regenerated by `frontend/blueprint/build-scripts/`):
  - ETOPO1 10-arcmin topography via fatiando-data
  - global-land-mask (GLOBE)
  - Natural Earth (India point of view)
  - DataMeet India states (CC BY 4.0)
  - NASA Black Marble night lights (via the three-globe example)
  - Solar System Scope textures (CC BY 4.0): Sun, Moon, Milky Way
  - Stellarium planet textures (GPL; attribution kept)
  - three.js (MIT)
  - Fonts: Inter, Fredoka, JetBrains Mono (SIL Open Font License) via @fontsource
