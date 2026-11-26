# Training tweaks — before/after (branch `tweaks`)

**Verdict (sections A–D, incl. new inputs): no tweak adopted. Shipped weights (`backend/weights/model.pt`, `model.onnx`) are unchanged.**

## Protocol
- Every variant: fine-tune from the current best weights, seed 42, 2 epochs of 8-day rollouts (10 for h10), batch 4,
  lr 5e-5 cosine (EMA: 1.5e-5, decay 0.999), checkpoint every half epoch. Code: `training/finetune.py`.
- `control` = same fine-tune with no tweak, so a tweak is judged against "just trained more", not only against the start.
- Scoring: `backend/eval/tweak_eval.py` = the local grader (monsoon_r1.scoring) on
  **tune** = 2019–2020 windows (10 events + 41 random = 51) and **confirm** = 2021 windows (5 events + 19 random = 24).
  All three judge shocks run on every event window, so causality is a pass rate. CPU = one 10-step call, 4 threads.
- Selection key: total, then mean SS + CSI skill (total alone is saturated in places).

## A. Correctness audit — all correct, nothing changed
| check | result |
|---|---|
| day-of-year | kit `doy_sincos` = 2π·yday/365 of last input day; train uses same; rollout adds +1 day per step (train, torch and ONNX runtimes) ✓ |
| latitude weights | `cos(lat)/mean` on the kit's LAT, same as `monsoon_r1.scoring` ✓ |
| perturbation | added in physical units to `init_states[-1]` before encoding ✓ |
| normalisation / channels | `norm.json` == checkpoint buffers exactly; channel order identical ✓ |
| note | the current checkpoint was selected on 2019–2021 val loss, so 2021 is not perfectly unseen for it |

## B/C. Results on tune (2019–2020); best checkpoint per variant
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

All 4 checkpoints per variant are in `cache/tweaks/<variant>/results.json` (git-ignored).

## C. New inputs (stem weights for the new channels start at ZERO: the starting model is bit-identical to current, max diff 0)
Same fine-tune schedule as above; best checkpoint per variant on tune (2019–2020).
| variant | total /70 | mean SS | CSI skill | blur pts | day-8 var ratio t2m/tp/u10/v10/msl/tcwv | caus pts | pass rate nonzero/local/propag/stable | null exact | CPU s/call |
|---|---|---|---|---|---|---|---|---|---|
| current (before) | 64.20 | +0.1059 | +0.0949 | 10.00 | 0.97/0.83/0.92/0.73/0.90/0.89 | 13.50 | 1.00 1.00 0.60 1.00 | yes (0) | 0.19* |
| control (no tweak) | 63.33 | +0.1037 | +0.0952 | 10.00 | 0.99/1.08/0.83/0.74/0.82/0.94 | 13.12 | 1.00 1.00 0.50 1.00 | yes (0) | 0.18* |
| toa (daily-mean top-of-atmosphere sunshine, analytic) | 63.48 | +0.1041 | +0.0955 | 10.00 | 0.99/1.08/0.83/0.74/0.82/0.94 | 13.12 | 1.00 1.00 0.50 1.00 | yes (0) | 0.07 |
| geo (6 static ERA5 maps) | 63.41 | +0.1031 | +0.0955 | 10.00 | 0.99/1.09/0.83/0.74/0.82/0.94 | 13.31 | 1.00 1.00 0.55 1.00 | yes (0) | 0.06 |
| coast (signed distance to coast) | 63.30 | +0.1037 | +0.0951 | 10.00 | 0.99/1.08/0.83/0.74/0.82/0.94 | 13.12 | 1.00 1.00 0.50 1.00 | yes (0) | 0.06 |
| D: avg(current, toa s637, toa s2549) | 64.37 | +0.1074 | +0.0959 | 10.00 | 0.98/0.95/0.88/0.74/0.86/0.92 | 13.12 | 1.00 1.00 0.50 1.00 | yes (0) | 0.08 |

\* CPU times from the earlier session; the machine was less loaded this time (0.06–0.08 s). All well under the 5 s limit.

- Each new input on its own ≈ control (±0.15): the model does not use them in a short fine-tune from converged weights.
  Their later checkpoints (s2549) reach the same propagates 0.80 / caus 14.25 as `outnoise`, again at a skill cost.
- The toa average is the only candidate above current on total (+0.17, SS +0.0015, CSI +0.0010), but it **loses
  causality points (13.50 → 13.12, propagates 0.60 → 0.50)** → rejected on tune, so the one-time 2021 check was not spent on it.
- Static maps: `backend/weights/static_extra.npz` (7×32×36, z-scored; sdor, slor, cvh, cvl, soil_type, lake_cover,
  coast_dist), built once by `backend/tools/build_static_extra.py` with the kit's own archive address and `half_degree`
  regrid (its land_sea_mask matches the kit's exactly). TOA is computed inside the network from latitude and the
  predicted day's angle, so serving needs no file and no download; both export to ONNX (torch vs ONNX 2.6e-6 std).
- Recommendation for the bigdata retrain: train from scratch with `toa+geo+coast` on (free, zero-cost at serving) together
  with `outnoise` and EMA; there the network can actually learn to use them.

## Confirmation on 2021 (run once, for the best tune candidate)
| model | total /70 | forecast pts /45 | mean SS | CSI skill | blur | caus | pass rates | null | CPU |
|---|---|---|---|---|---|---|---|---|---|
| current | **68.11** | 45.00 | +0.1184 | +0.1010 | 10.00 | 13.50 | 1.00 1.00 0.60 1.00 | yes | 0.19 |
| avg top-3 | 67.88 | 44.38 | +0.1175 | +0.1032 | 10.00 | 13.50 | 1.00 1.00 0.60 1.00 | yes | 0.18 |

The average loses forecast points on 2021 → rejected under the "no section may get worse" rule.

## What we learned (for the bigdata retrain)
- **Won as fine-tunes: none.** The current model is at a good optimum; any extra training at lr 5e-5 lowers skill (control −0.9).
- **Worth trying from scratch in the retrain (they help causality, which is the one section below max):**
  `outnoise` and `skillnorm` lift the "propagates" pass rate 0.60 → 0.80 (caus 13.5 → 14.25 / 14.06), at a skill cost
  when bolted onto converged weights. In a full retrain they may not cost skill. skillnorm also lowered "stable" to 0.95 — watch it.
- **EMA weights** were the least harmful change; cheap to keep on in a retrain.
- **Drop:** `raindirect` (clearly worse: −6.9 total, CSI −0.02), `h10` (no gain over 8-day rollouts), `leadw` (≈ control).
- Padding is already replicate.

## Checks
- Repo scan 15/15. Null shock exact (max dev 0) for every variant. CPU ≤ 0.21 s per 10-step call.
- Torch vs ONNX (clean Python 3.12 venv with onnxruntime): shipped model.onnx vs model.pt 2.2e-6; fresh exports of the
  current and the all-new-inputs model 2.6e-6 (std units).
- Final checks from a fresh clone: see the table below.
