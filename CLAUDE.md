# Monsoon Digital Twin — Track 2 "Multiverse of Monsoon" (Yugaantar DevForge)

## What we're building
A fast, physics-aware digital twin of India's daily weather:
- **Timeline Prime**: from 3 days of state, roll forward day by day (10+ steps) without exploding or blurring.
- **Multiverse**: accept a localized shock (perturbation) and show it ripple outward across India.
- Later: a realistic 3D dashboard + backend gateway, and an impact module (heatwave / crop stress), all driven LIVE by our own /simulate.

## Environment
- Windows 11, PowerShell, Python venv at `.venv` (always use it). VS Code.
- Laptop: RTX 5050 8 GB (Blackwell; needs PyTorch built for CUDA 12.8+), 16 GB RAM. Train on GPU; serving must run on CPU.
- Team kit installed in the venv as `monsoon_r1` (source: https://github.com/OfficialAbhinavSingh/yug-monsoon-kit). READ ITS SOURCE before writing eval code: `monsoon_r1/scoring.py`, `contract.py`, `client.py`, `schema_validator.py`, `repo_scan.py`, and `docs/R1_CONTRACT.md` in the kit repo. Reuse its functions instead of re-implementing scoring.
- Data (git-ignored, never commit): `data/india_climate_train.nc` — variable `data` (time=6209 days 2005-01-01..2021-12-31, channel=6, lat=32, lon=36), variable `static` (land_sea_mask, orography_m). `data/stats.json` has per-channel mean/std.
- Channels in order: t2m (K), tp (mm/day), u10 (m/s), v10 (m/s), msl (Pa), tcwv (kg/m2). Grid lat 6.5..37.5 (S→N), lon 65.5..100.5 (W→E), 1°.

## Judging (hard facts — design around these)
- Run offline: `python serve.py --port 8000`, listens on 0.0.0.0. 6 GB RAM, 4 CPU cores, NO GPU, no internet. Repo is read-only; write only to /tmp.
- Allowed libs at judging: torch (CPU), numpy, scipy, pandas, xarray, scikit-learn, lightgbm, onnxruntime, fastapi, flask, uvicorn, gunicorn. Anything else must be vendored in the repo.
- POST /health → {"status":"ready","model_name":...}; grader polls up to 120 s (do all warm-up there).
- POST /simulate: {"init_states":[3,6,32,36], "doy_sincos":[sin,cos] for the LAST input day, "steps":10, "perturbation": null | [6,32,36] physical delta added to init_states[-1]} → {"rollout":[steps,6,32,36], "inference_ms":float}. Plain nested JSON lists, physical units, finite floats only.
- Each 10-step call must finish < 5.0 s wall time. Local HTTP calls to the starter server measured ~0.2–0.3 s on the laptop; the judge box may be slower, so keep the JSON encode/decode path fast anyway (avoid FastAPI's jsonable_encoder; build the response fast).
- 8 hidden calls: 5 real windows after 2023-01-10 (monsoon onset, heavy rain, heatwave, cyclone, western disturbance) + 3 shocks (warm_ocean: +3 K t2m and +15% tcwv in Bay of Bengal box lat 8–20 lon 82–94; monsoon_stall: −40% u10/v10 in Arabian Sea box lat 8–20 lon 65–75; null: zeros must give output identical to no-perturbation within 1e-3 std → model must be deterministic).
- Scoring: forecast skill 45 (lat-weighted RMSE skill vs the better of persistence and climatology at days 1, 4, 8, all channels; full marks at skill 0.12) + heavy-rain CSI at 10 mm/day (15). Dynamics 25: anti-blur (day-8 spatial variance 40–250% of real, per channel) + shock causality (day-1 ≥60% response energy within 3 cells of the box; spreads outward days 4–8, never faster than 8 cells/day; never >5 std).
- Hard gate: beat persistence at day 4; valid on all 8 (no NaN/Inf, rain ≥ 0, t2m in [233.15, 333.15] K); localized non-zero response to ≥1 shock.
- Repo scan: no weather APIs, no hardcoded dates, no lookup tables or shipped archives of past weather, real training code, weights inside repo (Git LFS ok, < 2 GB). Dashboard code must be separate from server code. Repo must be created during the hackathon (it was).

## Repo layout (keep to this)
- `serve.py` (root) — inference server only
- `model/` network + inference wrapper; `training/` training code; `eval/` baselines + local grader; `weights/` (Git LFS); `tools/` one-off scripts
- `gateway/` dashboard backend (later); `dashboard/` 3D frontend (later); `brief/` 2-page PDF material

## Working rules
- The user does not write code; explain each step briefly in plain language (what it does and why) so he understands the system.
- Work layer by layer. After each layer works, run its check, then `git add` + `git commit` with a clear message, and `git push`.
- Gateway rules: never write the route text in gateway .py (paths live in gateway/config.json); presets are 6 short validation windows in gateway/presets (dashboard only, never imported by serve.py) — the only past-weather data allowed in the repo.
- Never commit `data/*.nc` or `.venv`. All .npy/.npz caches go in git-ignored `cache/` (repo_scan flags arrays with >400 days of 32x36 grids as a weather archive). Never write the route string "/simulate" outside serve.py — repo_scan treats any such file (and its imports) as inference code; eval uses monsoon_r1.client. Never hardcode dates or ship past-weather data in the repo.
- Validation split: train 2005–2018, validate 2019–2021. Report every result against persistence and climatology.
