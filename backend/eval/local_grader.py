"""Local copy of the Round-1 judge, built on monsoon_r1.scoring (we never re-implement the scoring maths).

Usage:
  python -m backend.eval.local_grader --url http://127.0.0.1:8000        # end-to-end through serve.py over HTTP
  python -m backend.eval.local_grader --model backend.eval.baselines:persistence  # call a Python function directly (fast)
  python -m backend.eval.local_grader --model serve:simulate

NOTE: never write the HTTP route string of the server in this file: the judge's repo_scan would then treat this
file as inference code. All HTTP goes through monsoon_r1.client.

Test windows come from the validation years 2019-2021 and are chosen from the data by simple criteria that mimic the
5 hidden cases (onset, heavy rain, heatwave, cyclone, western disturbance), plus N random windows.
"""
from __future__ import annotations
import argparse, datetime as dt, importlib, sys, time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from monsoon_r1 import contract as C, scoring as S                     # noqa: E402
from monsoon_r1 import stats as KS                                      # noqa: E402
from monsoon_r1.client import call_simulate, wait_ready                 # noqa: E402
from backend.eval.baselines import VAL_YEARS, load_data, load_std, train_climatology  # noqa: E402

STEPS = C.SCORE_STEPS
LEADS = [d - 1 for d in C.LEAD_DAYS]          # day 1, 4, 8 -> indices 0, 3, 7


def _box(box):
    return C.box_mask(box)


# ---- window selection ------------------------------------------------------------------------------------
def pick_windows(n_random: int = 20, seed: int = 0, with_scores: bool = False):
    """Return list of (label, t) where t is the index of the LAST input day. Inputs t-2..t, truth t+1..t+10."""
    data, dates, static = load_data()
    land = static[0] > 0.5
    tp, t2m, msl = data[:, 1], data[:, 0], data[:, 4]
    n = len(dates)
    ok = [t for t in range(2, n - STEPS) if dates[t - 2].year in VAL_YEARS and dates[t + STEPS].year in VAL_YEARS]
    fut = lambda x, t: x[t + 1:t + 1 + STEPS]                         # next 10 days
    kerala = _box((8, 13, 74, 78)) & land
    north = _box((20, 30, 70, 85)) & land
    wd = _box((30, 37.5, 70, 80))
    bob = _box((8, 22, 80, 95)) & ~land

    crit = {
        # monsoon onset: rain over Kerala jumps from the 3 input days to the next 10 days (late May .. mid June inits)
        "onset": (lambda d: (5, 20) <= (d.month, d.day) <= (6, 15),
                  lambda t: fut(tp, t)[:, kerala].mean() - tp[t - 2:t + 1][:, kerala].mean()),
        # heavy-rain spell: most land cells above 10 mm/day over the next 10 days (Jul/Aug)
        "heavy_rain": (lambda d: d.month in (7, 8), lambda t: (fut(tp, t)[:, land] > S.RAIN_THRESH).sum()),
        # pre-monsoon heatwave: hottest next 10 days over north-central India land (May)
        "heatwave": (lambda d: d.month == 5, lambda t: fut(t2m, t)[:, north].mean()),
        # cyclone-like: deepest sea-level-pressure low over the Bay of Bengal in the next 10 days (any month)
        "cyclone": (lambda d: True, lambda t: -fut(msl, t)[:, bob].min()),
        # western disturbance: most rain over the far north in the next 10 days (Dec-Feb)
        "western_disturbance": (lambda d: d.month in (12, 1, 2), lambda t: fut(tp, t)[:, wd].mean()),
    }
    out = []
    for name, (season, score) in crit.items():
        for yr in VAL_YEARS:
            cand = [t for t in ok if dates[t].year == yr and season(dates[t])]
            if cand:
                best = max(cand, key=score)
                out.append((f"{name}:{yr}", best, float(score(best))) if with_scores else (f"{name}:{yr}", best))
    rng = np.random.default_rng(seed)
    used = {w[1] for w in out}
    pool = [t for t in ok if t not in used]
    for t in sorted(rng.choice(pool, n_random, replace=False)) if n_random else []:
        out.append(("random", int(t), float("nan")) if with_scores else ("random", int(t)))
    return out


def window_arrays(t):
    data, dates, _ = load_data()
    init = data[t - 2:t + 1]
    truth = data[t + 1:t + 1 + STEPS]
    clim = train_climatology()
    clim_f = np.stack([KS.clim_for(clim, dates[t + 1 + k]) for k in range(STEPS)])
    doy = dates[t].timetuple().tm_yday
    return init, truth, clim_f, C.doy_sincos(doy), dates[t]


# ---- model callers ---------------------------------------------------------------------------------------
def http_caller(url):
    ok, why = wait_ready(url, 120, allow_private=True)
    if not ok:
        sys.exit(f"server not ready: {why}")
    import requests
    sess = requests.Session()

    def call(init, doy_sc, pert):
        payload = {"init_states": C.encode_list(init), "doy_sincos": doy_sc, "steps": STEPS,
                   "perturbation": None if pert is None else C.encode_list(pert)}
        r = call_simulate(url, payload, session=sess, allow_private=True)
        return (r.out if r.ok else None), r.wall_s, r.error
    return call


def func_caller(spec):
    mod, fn = spec.split(":")
    f = getattr(importlib.import_module(mod), fn)

    def call(init, doy_sc, pert):
        t0 = time.perf_counter()
        try:
            out = np.asarray(f(init.copy(), doy_sc, STEPS, None if pert is None else pert.copy()), "f4")
            return out, time.perf_counter() - t0, ""
        except Exception as e:
            return None, time.perf_counter() - t0, f"{type(e).__name__}: {e}"
    return call


# ---- grading ---------------------------------------------------------------------------------------------
def grade(call, n_random=20, shock_bases=1, verbose=True, wins=None):
    std = load_std()
    wins = pick_windows(n_random) if wins is None else wins
    null_dev = 0.0
    ss_w, csi_w, blur, sp_day4, times, invalid = [], [], [], [], [], []
    acc = {k: [] for k in ('m', 'p', 'c', 't')}                       # leads-only arrays for the per-channel table
    rows = []
    for label, t in wins:
        init, truth, clim_f, doy_sc, d = window_arrays(t)
        out, wall, err = call(init, doy_sc, None); times.append(wall)
        bad = [err] if out is None else S.validity(out, STEPS)
        if bad:
            invalid.append((label, str(d), bad)); rows.append((label, d, None, None, None, wall, bad)); continue
        pers = np.repeat(init[-1][None], STEPS, 0)
        sk = S.skill_vs_best_ref(out[LEADS], truth[LEADS], pers[LEADS], clim_f[LEADS])
        ss = float(np.nanmean(sk["ss"]))
        sk4 = S.skill_vs_best_ref(out[3:4], truth[3:4], pers[3:4], clim_f[3:4])
        sp_day4.append(sk4["rmse"] / np.maximum(S.rmse_lat(pers[3:4], truth[3:4]), 1e-12))
        c_m = S.csi(out[LEADS, 1], truth[LEADS, 1])
        cs = S.csi_skill(c_m, S.csi(pers[LEADS, 1], truth[LEADS, 1]), S.csi(clim_f[LEADS, 1], truth[LEADS, 1]))
        acc['m'].append(out[LEADS]); acc['p'].append(pers[LEADS]); acc['c'].append(clim_f[LEADS]); acc['t'].append(truth[LEADS])
        ss_w.append(ss); csi_w.append(cs); blur.append(S.variance_ratio(out[7], truth[7]))
        rows.append((label, d, ss, cs, float(np.nanmean(sk["ss_persist"])), wall, []))

    fp = S.forecast_points(ss_w, csi_w)
    blur_pts = S.anti_blur_points(np.array(blur)) if blur else 0.0

    # shocks on the first `shock_bases` named-event windows
    shock_res, null_ok_all, shock_valid = [], True, True
    bases = [w for w in wins if w[0] != "random"][:shock_bases]
    for label, t in bases:
        init, *_ , doy_sc, d = window_arrays(t)
        base, w0, e0 = call(init, doy_sc, None)
        for name, box in (("warm_ocean", C.BOX_BAY_OF_BENGAL), ("monsoon_stall", C.BOX_ARABIAN_SEA)):
            sh, w, e = call(init, doy_sc, S.make_shock(name, init[-1], std)); times.append(w)
            if base is None or sh is None or S.validity(sh, STEPS):
                shock_valid = False; r = {"nonzero": False, "localized": False, "propagates": False, "stable": False}
            else:
                r = S.causality_checks(base, sh, box, std)
            shock_res.append((f"{name}@{label}", r))
        nl, w, e = call(init, doy_sc, S.make_shock("null", init[-1], std)); times.append(w)
        null_ok = base is not None and nl is not None and S.null_consistent(base, nl, std)
        if null_ok: null_dev = max(null_dev, float((np.abs(base - nl) / std[None, :, None, None]).max()))
        null_ok_all &= null_ok
    caus_pts = np.mean([S.causality_points([r for n, r in shock_res[2 * i:2 * i + 2]], null_ok_all)
                        for i in range(len(bases))]) if bases else 0.0

    # hard gate
    beat_p4 = bool(sp_day4) and float(np.mean(np.array(sp_day4))) < 1.0  # mean RMSE ratio model/persistence < 1 at day 4
    all_valid = not invalid and shock_valid
    any_local = any(r["nonzero"] and r["localized"] for _, r in shock_res)
    gate = beat_p4 and all_valid and any_local
    model_pts = fp["rmse_pts"] + fp["csi_pts"] + blur_pts + caus_pts

    if verbose:
        print(f"\n{'window':28s} {'last input':>10s} {'SS':>7s} {'CSI-SS':>7s} {'SS-pers':>7s} {'sec':>5s}")
        for label, d, ss, cs, spp, wall, bad in rows:
            f = lambda x: "   nan" if x is None or not np.isfinite(x) else f"{x:+7.3f}"
            print(f"{label:28s} {str(d):>10s} {f(ss)} {f(cs)} {f(spp)} {wall:5.2f} {'INVALID ' + str(bad) if bad else ''}")
        if acc['m']:
            A = {k: np.stack(v) for k, v in acc.items()}
            print("\nlat-weighted RMSE in std units, model / persistence / climatology, then skill vs the better ref:")
            print("  lead" + "".join(f"{c:>21s}" for c in C.CHANNELS))
            for li, lead in enumerate(C.LEAD_DAYS):
                r = {k: S.rmse_lat(A[k][:, li], A['t'][:, li]) / std for k in 'mpc'}
                print(f"  d{lead:<3d}" + "".join(f"  {r['m'][c]:5.3f}/{r['p'][c]:5.3f}/{r['c'][c]:5.3f}" for c in range(6)))
                print("    SS" + "".join(f"{v:+21.3f}" for v in 1 - r['m'] / np.minimum(r['p'], r['c'])))
        print("\nshocks:")
        for n, r in shock_res:
            print(f"  {n:40s} nonzero={r['nonzero']!s:5} localized={r['localized']!s:5} (day1 near={r.get('near_frac_day1', 0):.2f}) "
                  f"propagates={r['propagates']!s:5} stable={r['stable']!s:5}")
        print(f"  null shock identical to no-shock: {null_ok_all}")
        ratios = np.nanmean(np.array(blur), 0) if blur else np.full(6, np.nan)
        print("\nday-8 variance ratio per channel:", " ".join(f"{c}={v:.2f}" for c, v in zip(C.CHANNELS, ratios)))
        print("\n================ SCORECARD (model part, 70 of 100) ================")
        print(f"  forecast skill  {fp['rmse_pts']:5.1f} / 30   (mean SS {fp['mean_ss']:+.3f}; full marks at +{S.SS_REF})")
        print(f"  heavy-rain CSI  {fp['csi_pts']:5.1f} / 15   (mean CSI skill {fp['mean_csi_skill']:+.3f}; full at +{S.CSI_SS_REF})")
        print(f"  anti-blur       {blur_pts:5.1f} / 10")
        print(f"  causality       {caus_pts:5.1f} / 15")
        print(f"  subtotal        {model_pts:5.1f} / 70")
        print("  HARD GATE:", "PASS" if gate else "FAIL",
              f"[beat persistence day4: {beat_p4}, all valid: {all_valid}, localized shock: {any_local}]")
        print(f"  => estimated model score: {model_pts if gate else 0.0:.1f} / 70  (+ repo 15 + brief 15 judged separately)")
        print(f"  time per call: mean {np.mean(times):.2f}s  max {np.max(times):.2f}s  (limit {C.TIME_LIMIT_S}s)"
              f"{'  TOO SLOW' if max(times) >= C.TIME_LIMIT_S else ''}")
    return {"forecast": fp, "blur_pts": blur_pts, "caus_pts": caus_pts, "gate": gate, "model_pts": model_pts,
            "blur_ratios": np.nanmean(np.array(blur), 0) if blur else None, "shocks": shock_res, "null_ok": null_ok_all,
            "null_dev": null_dev, "beat_p4": beat_p4, "max_s": float(np.max(times)), "mean_s": float(np.mean(times))}


def repo_scan_report():
    """Run the judge's repo_scan on a copy of the TRACKED files only (what the judge's clone sees)."""
    import json, shutil, subprocess, tempfile
    from monsoon_r1.repo_scan import scan
    root = Path(__file__).resolve().parents[2]
    files = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True).stdout.split()
    with tempfile.TemporaryDirectory() as tmp:
        for f in files:
            if (root / f).is_file():
                (Path(tmp) / f).parent.mkdir(parents=True, exist_ok=True); shutil.copy2(root / f, Path(tmp) / f)
        r = scan(tmp)
    print("\n================ REPO SCAN (judge's repo_scan on tracked files) ================")
    print(f"  points {r['points']} / 15  (anti-cheat {r['anti_cheat_points']} / 8, code health {r['code_health_points']} / 7)")
    print(f"  inference_files: {r['inference_files']}")
    for fl in r["flags"]:
        print(f"  [{fl['level'].upper()}] {fl['what']}" + (f"  ({fl['file']})" if "file" in fl else ""))
    print("  health:", json.dumps(r["health"]))
    return r


def main(argv=None):
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--url"); g.add_argument("--model", help="module:function, e.g. backend.eval.baselines:persistence")
    ap.add_argument("--n-random", type=int, default=20)
    ap.add_argument("--shock-bases", type=int, default=1, help="how many event windows to run the 3 shocks on")
    ap.add_argument("--list-windows", action="store_true")
    a = ap.parse_args(argv)
    if a.list_windows:
        _, dates, _ = load_data()
        for label, t in pick_windows(a.n_random):
            print(f"{label:28s} {dates[t]}")
        return
    grade(http_caller(a.url) if a.url else func_caller(a.model), a.n_random, a.shock_bases)
    repo_scan_report()


if __name__ == "__main__":
    main()
