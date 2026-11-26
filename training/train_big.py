"""From-scratch retrain on more years.   python -m training.train_big [--smoke]

Data = separate contiguous segments (a training window never crosses a gap between them):
  1979-1983 (extra, half weight) | 1995-2004 (extra) | 2005-2018 official train (2019-2021 = validation, never fitted) | 2022 (extra)
The extra years come from the same archive and builder as the official file (team kit build_dataset), in
data/extra/ (git-ignored). Normalisation is still computed on the official 2005-2018 years, as in training/train.py.
Winning ideas from the tweaks study switched on: new inputs (TOA sunshine + 7 static maps), noise on the model's own
fed-back outputs in the rollout stage, EMA weights. Checkpoints are chosen by the FULL local grader on 2019-2020
windows (backend/eval/tweak_eval.py), and the top 3 are also averaged. Everything goes to git-ignored cache/big/.
"""
from __future__ import annotations
import argparse, copy, datetime as dt, glob, json, math, os, sys, time
from pathlib import Path

import numpy as np
import torch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from training.train import set_seed, build_model, batch, loss_fn, validate     # noqa: E402
from backend.eval.baselines import load_data, load_std, DATA_DIR               # noqa: E402
from backend.eval import tweak_eval                                            # noqa: E402
from backend.model.net import MonsoonNet                                       # noqa: E402

OUT = ROOT / "cache" / "big"
BIG = dict(a_epochs=18, a_lr=1e-3, a_bs=32, horizons=[2, 4, 8], b_epochs=[4, 4, 6], b_lr=2e-4, b_bs=[16, 8, 4],
           in_noise=0.02, out_noise=0.03, ema_decay=0.999, old_weight=0.5, old_end=dt.date(1983, 12, 31))


def _ymd(x):
    s = str(int(x)); return dt.date(int(s[:4]), int(s[4:6]), int(s[6:]))


def load_npz_parts(paths, last=None):
    data, dates = [], []
    for p in sorted(paths):
        z = np.load(p); d = [_ymd(x) for x in z["dates"]]
        keep = [i for i, x in enumerate(d) if last is None or x <= last]
        data.append(z["data"][keep].astype("f4")); dates += [d[i] for i in keep]
    data = np.concatenate(data); order = np.argsort(np.array([x.toordinal() for x in dates]))
    data, dates = data[order], [dates[i] for i in order]
    keep = [0] + [i for i in range(1, len(dates)) if dates[i] != dates[i - 1]]          # drop duplicate days
    return data[keep], [dates[i] for i in keep]


def segments(smoke=False):
    ex = DATA_DIR / "extra"
    mid = [ex / "train_1995_2004.npz"]
    if smoke and not mid[0].exists():                                   # smoke test only: partial download
        mid = glob.glob(str(ex / "train_1995_2004.chunks" / "*.npz"))
    official, odates, static = load_data()
    segs = [("1979-1983", *load_npz_parts(glob.glob(str(ex / "train_1979_2004.chunks" / "*.npz")), BIG["old_end"])),
            ("1995-2004", *load_npz_parts(mid)),
            ("2005-2021 official", official, odates),
            ("2022", *load_npz_parts([ex / "train_2022.npz"]))]
    return segs, static


def build(segs, val_years=(2019, 2021)):
    """One array; per-day segment id; train/val masks. Gaps inside a segment also split it (date must step by 1 day)."""
    data = np.concatenate([s[1] for s in segs]); dates = sum([s[2] for s in segs], [])
    sid = np.zeros(len(dates), int); k = 0
    for i in range(1, len(dates)):
        if (dates[i] - dates[i - 1]).days != 1:
            k += 1
        sid[i] = k
    yr = np.array([d.year for d in dates])
    is_off = np.concatenate([np.full(len(ds), n.startswith("2005")) for n, _, ds in segs])
    val = is_off & (yr >= val_years[0]) & (yr <= val_years[1])
    return data, dates, sid, val


def starts(sid, mask, h):
    n = len(sid)
    return [t for t in range(2, n - h) if sid[t - 2] == sid[t + h] and mask[t - 2] and mask[t + h]]


def epoch_order(st, dates, rng):
    """Half weight for the oldest years: each of their windows is used with probability old_weight per epoch."""
    st = np.array(st); old = np.array([dates[t] <= BIG["old_end"] for t in st])
    keep = ~old | (rng.random(len(st)) < BIG["old_weight"])
    return rng.permutation(st[keep])


def arch_of(m):
    return {"width": m.width, "n_blocks": m.n_blocks, "rain_direct": m.rain_direct, "n_extra": m.n_extra, "toa": m.toa}


def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--smoke", action="store_true"); a = ap.parse_args(argv)
    cfg = yaml.safe_load(open(ROOT / "training" / "config.yaml")); set_seed(cfg["seed"])
    global OUT
    if a.smoke:
        BIG.update(a_epochs=1, b_epochs=[1, 1, 1]); OUT = OUT / "smoke"
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log = lambda s: print(s, flush=True)
    segs, static = segments(a.smoke)
    for n, d, ds in segs:
        log(f"segment {n:20s} {ds[0]} .. {ds[-1]}  {len(ds)} days")
    data, dates, sid, val = build(segs)
    train = ~val
    # normalisation + base model exactly as training/train.py (official 2005-2018 only)
    off_data, off_dates, _ = load_data()
    base = build_model(cfg, off_data, off_dates, static, load_std())
    extra = np.load(ROOT / "backend" / "weights" / "static_extra.npz")["fields"]
    model = MonsoonNet(base.width, base.n_blocks, static=base.static, lat=None, mean=base.mean, std=base.std,
                       n_extra=len(extra), toa=True)
    model.lat_w.copy_(base.lat_w); model.extra.copy_(torch.as_tensor(extra)); model = model.to(device)
    with torch.no_grad():
        Z = model.encode(torch.as_tensor(data).to(device))
    std_phys = torch.as_tensor(load_std(), device=device)
    val_st = starts(sid, val, 8)[::cfg["data"]["val_every_nth"]]
    rng = np.random.default_rng(cfg["seed"]); OUT.mkdir(parents=True, exist_ok=True)
    mb = 3 if a.smoke else 0
    ema, results, t_all = None, [], time.time()

    plan = [("A h=1", 1, BIG["a_epochs"], BIG["a_lr"], BIG["a_bs"])] + \
           [(f"B h={h}", h, e, BIG["b_lr"], bs) for h, e, bs in zip(BIG["horizons"], BIG["b_epochs"], BIG["b_bs"])]
    for name, h, epochs, lr, bs in plan:
        st = starts(sid, train, h); nb = int(len(st) * (1 - 0.5 * np.mean([dates[t] <= BIG["old_end"] for t in st]))) // bs
        if mb: nb = mb
        opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
        sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=max(epochs * nb, 1), pct_start=0.05)
        rollout_stage = name.startswith("B")
        if rollout_stage and ema is None:
            ema = copy.deepcopy(model).eval()
        for ep in range(1, epochs + 1):
            t0 = time.time(); order = epoch_order(st, dates, rng); tl = 0.0
            for b in range(min(nb, len(order) // bs)):
                idx = order[b * bs:(b + 1) * bs].tolist()
                inp, tgt, ang = batch(Z, idx, h, dates, device)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                    pred = model.rollout(inp, ang, h, noise_std=0.0 if rollout_stage else BIG["in_noise"],
                                         out_noise=BIG["out_noise"] if rollout_stage else 0.0)
                loss, _, _ = loss_fn(model, pred.float(), tgt, cfg, std_phys)
                opt.zero_grad(set_to_none=True); loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); sched.step(); tl += loss.item()
                if ema is not None:
                    with torch.no_grad():
                        for pe, pm in zip(ema.parameters(), model.parameters()):
                            pe.lerp_(pm, 1 - BIG["ema_decay"])
            m = ema if ema is not None else model
            vl = validate(m, Z, val_st, dates, 8, device); m.eval()
            msg = f"[{name}] ep {ep}/{epochs} loss {tl / max(nb, 1):.4f} val8 {vl:.4f} {time.time() - t0:.0f}s (total {(time.time() - t_all) / 60:.1f} min)"
            if h == 8:
                tag = f"b8e{ep}"; ck = {"arch": arch_of(m), "state_dict": copy.deepcopy(m.state_dict())}
                torch.save(ck, OUT / f"{tag}.pt")
                r = tweak_eval.evaluate(m, "tune"); r["ckpt"] = tag; results.append(r)
                msg += "\n" + tweak_eval.fmt(tag, r)
            log(msg)
    # D: average the top 3 checkpoints by the grader key
    top = sorted(results, key=lambda r: r["key"], reverse=True)[:3]
    sds = [torch.load(OUT / f"{r['ckpt']}.pt", map_location="cpu", weights_only=False)["state_dict"] for r in top]
    avg = copy.deepcopy(ema).cpu(); avg.load_state_dict({k: sum(s[k].float() for s in sds) / len(sds) for k in sds[0]})
    torch.save({"arch": arch_of(avg), "state_dict": avg.state_dict()}, OUT / "avg3.pt")
    r = tweak_eval.evaluate(avg, "tune"); r["ckpt"] = "avg3(" + ",".join(t["ckpt"] for t in top) + ")"; results.append(r)
    log(tweak_eval.fmt(r["ckpt"], r))
    (OUT / "results.json").write_text(json.dumps(results, indent=1, default=str))
    best = max(results, key=lambda r: r["key"])
    log(f"done in {(time.time() - t_all) / 60:.1f} min; best on tune: {best['ckpt']} total {best['total']:.2f}")


if __name__ == "__main__":
    main()
