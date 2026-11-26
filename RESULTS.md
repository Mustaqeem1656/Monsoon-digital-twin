# Results — evidence for the rubric

All outputs below were produced on a **clean clone of `main` at commit `bd86051`**, which is identical to GitHub's
`main` (`git ls-remote origin main` = bd86051). A direct clone from GitHub stalled twice (timeout during
`index-pack`), so the clean clone was made from the local repository with `git clone --no-hardlinks -b main`.
Commits after `bd86051` add only this file and `results/`. Raw outputs are in [results/](results/).

Machine: Windows 11 laptop, CPU inference only (torch, 4 threads). Judge limits: 6 GB RAM, 4 CPU cores, no GPU, 5 s per call.

## Local grader (over HTTP, like the judge)
`python -m backend.eval.local_grader --url http://127.0.0.1:8001` · full output: [results/local_grader.txt](results/local_grader.txt)

| Part | Score | Detail |
|---|---|---|
| Forecast skill (RMSE vs better of persistence/climatology, days 1/4/8) | **30.0 / 30** | mean skill +0.131 (full marks at +0.12) |
| Heavy-rain CSI at 10 mm/day | **15.0 / 15** | mean CSI skill +0.147 (full marks at +0.10) |
| Anti-blur (day-8 spatial variance 40–250 %) | **10.0 / 10** | t2m 0.96, tp 0.61, u10 0.95, v10 0.81, msl 0.98, tcwv 0.94 |
| Shock causality | **13.1 / 15** | localized + stable on every shock; outward spread not always detected (monsoon_stall) |
| **Model subtotal** | **68.1 / 70** | |
| Hard gate | **PASS** | beats persistence at day 4: True; all outputs valid: True; localized shock: True |

35 windows from the validation years 2019–2021 (15 event windows + 20 random). These years were also used to pick the
checkpoint, so the scores are slightly optimistic (see README, Failure modes).

## Schema validator (organisers' kit)
`python -m monsoon_r1.schema_validator http://localhost:8001` → **all checks passed** (JSON lists and base64; no
perturbation, warm_ocean, zeros). [results/schema_validator.txt](results/schema_validator.txt)

## Repo scan (judge's `monsoon_r1.repo_scan` on the clean clone)
**15 / 15** (anti-cheat 8 / 8, code health 7 / 7), **no flags**. [results/repo_scan.json](results/repo_scan.json)

## Offline check
`git grep` over all tracked files for weather APIs / remote data sources (open-meteo, openweathermap, weatherapi,
visualcrossing, meteomatics, worldweatheronline, cdsapi, ERA5/WeatherBench buckets, accuweather, tomorrow.io) and for
any non-localhost http(s) URL in code, frontend included: **no matches**. [results/offline_check.txt](results/offline_check.txt).
Tracked files: [results/tracked_files.txt](results/tracked_files.txt) (77 files; the only arrays are fixed geography).

## Data check (`python backend/tools/verify_data.py`)
**16 / 16 PASS**: dataset = gateway = dashboard readout, map orientation, the forecast comes from serve.py, physical
units. [results/verify_data.txt](results/verify_data.txt)

## Timing and memory
| What | Measured |
|---|---|
| One 10-step `/simulate` call, grader over HTTP | mean 0.53 s, max 0.63 s (laptop also running the gateway); 0.20–0.35 s when idle. Limit 5 s |
| Schema-validator call (its own client incl. encoding) | 2.50–2.65 s |
| Server memory (serve.py, peak working set during the full grader run) | **598 MB** (limit 6 GB) |
| Impact ensemble (16 live /simulate calls) | 1.6–1.8 s (limit 5 s), `backend/gateway/test_gateway.py` |

## Training log
From `cache/train.log` (git-ignored; summary in [results/training_log_summary.txt](results/training_log_summary.txt)).
Code: `training/train.py`, settings: `training/config.yaml`. GPU: RTX 5050 Laptop. Model: 0.52 M parameters, receptive radius 7 cells/day.

| Stage | Rollout length | Epochs | Final train loss (mse, var) | Final val 8-day mse | Best val 8-day mse |
|---|---|---|---|---|---|
| A | 1 day | 30 | 0.0865 (0.0845, 0.0386) | 0.2437 | 0.2390 (ep 28) |
| B | 2 days | 6 | 0.1311 (0.1276, 0.0694) | 0.2262 | 0.2218 (ep 2) |
| B | 4 days | 6 | 0.1914 (0.1856, 0.1157) | 0.2105 | 0.2103 (ep 1) |
| B | 8 days | 8 | 0.2514 (0.2431, 0.1668) | 0.2090 | **0.2057 (ep 6)** |

**Total 45.3 min. Best checkpoint: stage B, 8-day rollouts, epoch 6 (val 8-day mse 0.2057) → `backend/weights/model.pt`.**
Split: train 2005–2018, validate 2019–2021.

## Ablations (branch `tweaks`, not merged)
Fine-tunes from the shipped weights, scored with the local grader on the 2019–2020 windows. Verdict: **no tweak
adopted; shipped weights unchanged.** Full file: [results/tweaks_ablation.md](results/tweaks_ablation.md).

| variant | total /70 | mean SS | CSI skill | blur pts | day-8 var ratio t2m/tp/u10/v10/msl/tcwv | caus pts | pass rate nonzero/local/propag/stable | null exact | CPU s/call |
|---|---|---|---|---|---|---|---|---|---|
| **current (before)** | **64.20** | +0.1059 | +0.0949 | 10.00 | 0.97/0.83/0.92/0.73/0.90/0.89 | 13.50 | 1.00 1.00 0.60 1.00 | yes (0) | 0.19 |
| control (no tweak) | 63.33 | +0.1037 | +0.0952 | 10.00 | 0.99/1.08/0.83/0.74/0.82/0.94 | 13.12 | 1.00 1.00 0.50 1.00 | yes (0) | 0.18 |
| 5 skillnorm | 61.63 | +0.0943 | +0.0932 | 10.00 | 0.98/1.21/1.01/0.87/0.92/0.93 | 14.06 | 1.00 1.00 0.80 0.95 | yes (0) | 0.18 |
| 6 leadw (×3 on d1/4/8) | 63.43 | +0.1035 | +0.0949 | 10.00 | 0.98/1.06/0.84/0.73/0.82/0.94 | 13.31 | 1.00 1.00 0.55 1.00 | yes (0) | 0.19 |
| 7 h10 | 62.23 | +0.0985 | +0.0915 | 10.00 | 0.97/0.98/0.89/0.74/0.84/0.93 | 13.88 | 1.00 1.00 0.70 1.00 | yes (0) | 0.19 |
| 8 replicate padding | — already the model's padding; nothing to test | | | | | | | | |
| 9 raindirect | 57.35 | +0.0903 | +0.0738 | 10.00 | 0.97/0.98/0.88/0.76/0.86/0.94 | 13.69 | 1.00 1.00 0.65 1.00 | yes (0) | 0.19 |
| 10 outnoise (σ 0.03 on fed-back outputs) | 63.37 | +0.1001 | +0.0940 | 10.00 | 0.97/0.99/0.89/0.75/0.85/0.93 | 14.25 | 1.00 1.00 0.80 1.00 | yes (0) | 0.19 |
| 11 EMA low-LR polish | 64.02 | +0.1052 | +0.0949 | 10.00 | 0.97/0.88/0.91/0.74/0.88/0.91 | 13.50 | 1.00 1.00 0.60 1.00 | yes (0) | 0.19 |
| C avg top-3 (current + EMA s637 + s1274) | 64.23 | +0.1057 | +0.0954 | 10.00 | 0.97/0.88/0.91/0.74/0.88/0.91 | 13.50 | 1.00 1.00 0.60 1.00 | yes (0) | 0.20 |
| C avg current + outnoise s2549 | 64.23 | +0.1050 | +0.0952 | 10.00 | 0.97/0.91/0.90/0.74/0.88/0.91 | 13.69 | 1.00 1.00 0.65 1.00 | yes (0) | 0.19 |
