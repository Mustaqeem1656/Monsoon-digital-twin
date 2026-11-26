# Monsoon Digital Twin — Track 2 "Multiverse of Monsoon"

A fast, physics-aware digital twin of India's daily weather, built for Yugaantar DevForge Track 2.

- **Timeline Prime**: give it 3 consecutive days of weather and it rolls forward day by day (10+ steps) without
  exploding or blurring.
- **Multiverse**: add a localized shock (e.g. a warmer Bay of Bengal, a stalled Arabian Sea monsoon flow) and watch
  the response ripple outward across India at a physically plausible speed.

The model works on a 32 × 36 grid of 1° cells (lat 6.5–37.5 °N, lon 65.5–100.5 °E) with 6 daily channels:
`t2m` (K), `tp` (mm/day), `u10`, `v10` (m/s), `msl` (Pa), `tcwv` (kg/m²). All I/O is in physical units.

## Repo layout

| Path | What it is |
|---|---|
| `serve.py` | The inference server the judge runs (FastAPI + uvicorn). Nothing else. |
| `model/net.py` | The network: a small, fully convolutional residual one-day stepper. |
| `model/runtime.py` | Inference engine used by the server: numpy rollout loop, torch or ONNX backend, safety net. |
| `model/inference.py` | Torch-only `simulate()` helper used by training and evaluation. |
| `training/train.py`, `training/config.yaml` | Training code and every tunable setting (commented). |
| `eval/baselines.py` | Persistence and day-of-year climatology (training years only). |
| `eval/local_grader.py` | Local copy of the judge, built on the official `monsoon_r1.scoring`. |
| `eval/impulse.py` | Impulse test: poke one cell, measure how far the response travels per day. |
| `tools/explore.py` | One-off data exploration and plots (laptop only). |
| `tools/export_onnx.py` | Exports `model.pt` → `model.onnx` and checks both give the same output. |
| `weights/` | `model.pt`, `model.onnx` (Git LFS), `norm.json` (normalisation constants + model name). |
| `gateway/`, `dashboard/` | Dashboard backend and 3D frontend (coming later; kept separate from the server). |

`data/` (the organisers' training archive) is git-ignored and never committed. Caches go in git-ignored `cache/`.

## Quick start (serve)

```bash
python serve.py --port 8000                                  # listens on 0.0.0.0
python -m monsoon_r1.schema_validator http://localhost:8000  # from the organisers' kit
```

- `POST /health` returns `{"status": "ready", "model_name": ...}` only after the model is loaded and warmed up
  (about 6 s); before that it returns 503 `"loading"`.
- `POST /simulate` with `{"init_states": [3,6,32,36], "doy_sincos": [sin, cos], "steps": N, "perturbation": null | [6,32,36]}`
  returns `{"rollout": [N,6,32,36], "inference_ms": ...}`. `steps` can be any positive integer.

Server dependencies are only: torch (CPU) or onnxruntime, numpy, fastapi, uvicorn, and the standard library. It runs on
CPU with 4 threads, uses about 250 MB of RAM, and writes nothing to disk.

## How to train

```powershell
python -m venv .venv
.venv\Scripts\activate
# GPU PyTorch (RTX 50xx / Blackwell needs CUDA 12.8+ wheels; pick the index matching your Python version):
pip install torch --index-url https://download.pytorch.org/whl/cu128    # we used cu132 on Python 3.15
pip install numpy scipy xarray netCDF4 fastapi uvicorn pyyaml requests matplotlib onnx
pip install <organisers' monsoon_r1 kit>
# put india_climate_train.nc and stats.json in data/
python training/train.py                       # full run, about 45 min on an RTX 5050 laptop GPU
python training/train.py --smoke               # 1 epoch per stage, 3 batches: proves the pipeline works
python tools/export_onnx.py                    # refresh weights/model.onnx after retraining
```

All settings are in `training/config.yaml`, with a plain-language comment on each line: model width and depth, epochs
per stage, learning rates, batch sizes, rollout lengths, loss weights, input noise, seed.

Training runs in two stages, with 2005–2018 used for training and 2019–2021 for validation:
1. **Stage A**: predict 1 day ahead.
2. **Stage B**: autoregressive fine-tuning on 2-, 4- and 8-day rollouts, with backprop through the whole rollout, so
   the model learns to stay stable on its own outputs.

The loss is latitude-weighted MSE in normalised units, with heavy-rain cells (> 10 mm/day) upweighted 5×. A spatial
variance-matching (anti-blur) term is added on top. The best checkpoint, by 8-day validation error, is saved to
`weights/model.pt`. When training ends, the impulse test, the full local grader and the repo scan run automatically.

## How to evaluate

```bash
python -m eval.local_grader --url http://127.0.0.1:8000         # end to end over HTTP, exactly like the judge
python -m eval.local_grader --model eval.baselines:persistence  # call any Python function directly (fast)
python -m eval.local_grader --model model.inference:simulate
python -m eval.local_grader --list-windows                      # show the chosen test windows
python -m eval.impulse                                          # locality / speed-limit check
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

## Model summary

- **Inputs (26 maps)**:
  - the last 3 days × 6 channels, normalised (rain as `log1p`)
  - land–sea mask and normalised orography (bundled in the checkpoint: fixed geography, not past weather)
  - day-of-year sin/cos of the day being predicted
  - latitude and longitude coordinate planes
- **Architecture**: a 3×3 conv stem, 3 residual blocks (two 3×3 convs each) and a 1×1 head, width 96.
  **About 523k parameters** (2 MB).
- **Residual rollout**: `next_state = current_state + network(inputs)`, applied day by day on the model's own outputs.
  The head starts at zero, so an untrained model is exactly persistence.
- **Local by construction**: the receptive field is **7 cells per day** (the judge's speed limit is 8). It uses
  per-cell LayerNorm instead of Batch/GroupNorm, because those average over the whole map and would teleport a shock
  everywhere at once.
- **Rain in log space** inside the model, and always ≥ 0 at the output. Temperature is clamped to a valid range, and
  moisture is ≥ 0.
- **Deterministic**: no dropout or sampling at inference, so a zero perturbation gives bit-identical output.
- **Speed**: a 10-step rollout over HTTP takes about 0.25 s on CPU (limit 5 s).

## Current local scores

Measured with `eval/local_grader.py` over HTTP against `serve.py`, in a fresh Python 3.12 venv with only the allowed
libraries. Validation years 2019–2021, 35 windows.

| Part | Estimate | Notes |
|---|---|---|
| Forecast skill (RMSE vs best of persistence/climatology) | **30.0 / 30** | mean skill +0.131 (full marks at +0.12) |
| Heavy-rain CSI at 10 mm/day | **15.0 / 15** | mean CSI skill +0.147 (full marks at +0.10) |
| Anti-blur (day-8 spatial variance) | **10.0 / 10** | 61–98 % of the real variance per channel |
| Shock causality | **13.1 / 15** | both shocks localised and stable; outward spread not always strong enough |
| Hard gate | **PASS** | beats persistence at day 4, all outputs valid, localised shock response |
| Repo scan (`monsoon_r1.repo_scan`) | see the latest run | anti-cheat 8 / 8 |

Skill against the better baseline, by lead day:

| Lead | Skill vs better baseline |
|---|---|
| Day 1 | +23 % to +33 % |
| Day 4 | +6 % to +16 % |
| Day 8 | about level with climatology |

## Torch → ONNX fallback

The server prefers `weights/model.pt` with torch. If torch is missing or the checkpoint will not load (for example
because of a version mismatch), it falls back to `weights/model.onnx` (opset 17) through onnxruntime. Both backends run
the same network step inside the same numpy rollout loop.

`tools/export_onnx.py` checks that the two agree: the maximum difference over a 10-step rollout is 1.5e-5 std. Run
`python tools/export_onnx.py --check` in an environment that has onnxruntime. We tested the fallback by starting the
server with torch blocked; it served correctly and passed the schema validator.

## Limitations

- **Coarse grid**: 1° cells cannot resolve cyclone cores, orographic rain bands or city-scale heat.
- **Daily means**: temperature and the other channels are daily averages, so day–night extremes (e.g. heatwave
  maximum temperatures) are not modelled directly.
- **Scores measured on 2019–2021**: the same years were used to pick the best checkpoint, so they are slightly
  optimistic. The judge's hidden cases are from later years.
- **Skill fades with lead time**: beyond about a week, skill is close to climatology.

## Data and credits

- **Training data**: the organisers' dataset (`india_climate_train.nc`, derived from ERA5) and the `monsoon_r1` kit
  (API contract, scoring, schema validator, repo scan). Neither is redistributed in this repo.
- **Dashboard imagery and geography** (used later by `dashboard/`, credited here in advance):
  - Solar System Scope textures, CC BY 4.0
  - Stellarium textures
  - Natural Earth
  - DataMeet (India boundaries)
  - ETOPO1 global relief (NOAA)
  - NASA Black Marble
