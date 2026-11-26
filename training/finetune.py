"""Short fine-tunes from the current best weights, one tweak at a time.   python -m training.finetune VARIANT [...]

Every variant: same seed, same data (train 2005-2018), same short schedule; only its tweak differs. 'control' has no
tweak, so we can tell a tweak's effect apart from "just trained a bit more". Checkpoints go to git-ignored
cache/tweaks/<variant>/ and each is scored on the 2019-2020 tune windows (backend/eval/tweak_eval.py).

Tweaks (switch on several with '+', e.g. skillnorm+leadw):
  skillnorm  each channel/lead error divided by the better baseline's error there (persistence or climatology)
  leadw      extra weight (x3) on rollout days 1, 4, 8 (the days the judge scores)
  h10        roll out 10 days instead of 8
  raindirect rain predicted outright instead of as a change from yesterday (other channels stay residual)
  outnoise   noise only on the model's own fed-back outputs (instead of on every input every step)
  ema        low learning rate polish, scoring exponential-moving-average weights
"""
from __future__ import annotations
import argparse, copy, json, math, sys, time
from pathlib import Path

import numpy as np
import torch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from training.train import Windows, batch, set_seed                 # noqa: E402
from backend.eval.baselines import load_data, load_std             # noqa: E402
from backend.eval import tweak_eval                                # noqa: E402
from backend.model.net import MonsoonNet, RAIN                     # noqa: E402

FT = dict(epochs=2, ckpts_per_epoch=2, lr=5e-5, bs=4, horizon=8, out_noise=0.03, ema_decay=0.999, ema_lr=1.5e-5,
          lead_extra=2.0)
OUT = ROOT / "cache" / "tweaks"


def load_init(path, rain_direct=False):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    m = MonsoonNet(**{**ck["arch"], "rain_direct": rain_direct or ck["arch"].get("rain_direct", False)})
    m.load_state_dict(ck["state_dict"]); return m


def baseline_mse(Z, dates, tr_win, H, lat_w):
    """[H,6] lat-weighted MSE (model space) of the better of persistence and climatology, per lead and channel."""
    tr = np.array(tr_win.inside); doy = np.array([min(d.timetuple().tm_yday, 365) for d in dates]) - 1
    Zc = Z.cpu().double(); clim = torch.zeros(365, *Zc.shape[1:], dtype=torch.float64)
    for d in range(365):                                                # 15-day smoothed calendar-day mean
        sel = tr & (np.minimum(np.abs(doy - d), 365 - np.abs(doy - d)) <= 7)
        clim[d] = Zc[torch.as_tensor(sel)].mean(0)
    w = lat_w.cpu().double()
    st = np.array(tr_win.starts(H))
    cm = (((Zc[st + 1] - clim[doy[st + 1]]) ** 2) * w).mean((0, 2, 3))
    out = torch.zeros(H, 6, dtype=torch.float64)
    for k in range(1, H + 1):
        pm = (((Zc[st + k] - Zc[st]) ** 2) * w).mean((0, 2, 3))
        out[k - 1] = torch.minimum(pm, cm)
    return out.float()


def loss_fn(model, pred, tgt, L, std_phys, Wkc):
    w_lat = model.lat_w
    rain_true_mm = torch.expm1((tgt[:, :, RAIN] * model.std[RAIN] + model.mean[RAIN]).clamp(min=0))
    wmap = torch.ones_like(tgt); wmap[:, :, RAIN] = 1 + L["rain_heavy_weight"] * (rain_true_mm > L["rain_heavy_mm"]).float()
    mse = ((pred - tgt) ** 2 * wmap * w_lat * Wkc[None, :, :, None, None]).mean()
    s = std_phys[:, None, None]
    pp, tt = model.decode(pred.float()) / s, model.decode(tgt.float()) / s
    vp, vt = pp.flatten(-2).var(-1), tt.flatten(-2).var(-1)
    var = ((torch.log(vp + 1e-4) - torch.log(vt + 1e-4)) ** 2).mean()
    return mse + L["variance_weight"] * var


def run(variant, init_path, cfg, device, log):
    tw = set(variant.split("+")) - {"control"}
    set_seed(cfg["seed"])
    H = 10 if "h10" in tw else FT["horizon"]
    data, dates, _ = load_data(); std_phys = torch.as_tensor(load_std(), device=device)
    model = load_init(init_path, "raindirect" in tw).to(device)
    with torch.no_grad():
        Z = model.encode(torch.as_tensor(data).to(device))
    tr_win = Windows(dates, cfg["data"]["train_years"])
    L = cfg["loss"]
    cw = torch.ones(6); cw[RAIN] = L["rain_channel_weight"]
    Wkc = cw[None].repeat(H, 1)
    if "skillnorm" in tw:
        b = baseline_mse(Z, dates, tr_win, H, model.lat_w); inv = 1 / b
        Wkc = Wkc * inv / inv.mean()
    if "leadw" in tw:
        lw = torch.ones(H); lw[[0, 3, 7]] += FT["lead_extra"]; Wkc = Wkc * (lw / lw.mean())[:, None]
    Wkc = Wkc.to(device)
    in_noise, out_noise = (0.0, FT["out_noise"]) if "outnoise" in tw else (L["input_noise"], 0.0)
    lr = FT["ema_lr"] if "ema" in tw else FT["lr"]
    ema = copy.deepcopy(model).eval() if "ema" in tw else None

    starts = tr_win.starts(H); nb = len(starts) // FT["bs"]
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    total = FT["epochs"] * nb
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: 0.5 * (1 + math.cos(math.pi * s / total)))
    every = nb // FT["ckpts_per_epoch"]
    od = OUT / variant; od.mkdir(parents=True, exist_ok=True)
    results, step = [], 0
    for ep in range(FT["epochs"]):
        perm = np.random.permutation(starts); t0 = time.time()
        for b in range(nb):
            idx = perm[b * FT["bs"]:(b + 1) * FT["bs"]].tolist()
            inp, tgt, ang = batch(Z, idx, H, dates, device)
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                pred = model.rollout(inp, ang, H, noise_std=in_noise, out_noise=out_noise)
            loss = loss_fn(model, pred.float(), tgt, L, std_phys, Wkc)
            opt.zero_grad(set_to_none=True); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); sched.step(); step += 1
            if ema is not None:
                with torch.no_grad():
                    for pe, pm in zip(ema.parameters(), model.parameters()):
                        pe.lerp_(pm, 1 - FT["ema_decay"])
            if (b + 1) % every == 0 and (b + 1) // every <= FT["ckpts_per_epoch"]:
                m = ema if ema is not None else model
                name = f"s{step}"
                torch.save({"arch": {"width": m.width, "n_blocks": m.n_blocks, "rain_direct": m.rain_direct},
                            "state_dict": copy.deepcopy(m.state_dict())}, od / f"{name}.pt")
                r = tweak_eval.evaluate(m, "tune"); r["ckpt"] = name; results.append(r)
                log(f"[{variant}] {name} ({time.time() - t0:.0f}s) {tweak_eval.fmt(name, r)}")
    (od / "results.json").write_text(json.dumps(results, indent=1, default=str))
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("variants", nargs="+")
    ap.add_argument("--init", default=str(ROOT / "backend" / "weights" / "model.pt"))
    a = ap.parse_args(argv)
    cfg = yaml.safe_load(open(ROOT / "training" / "config.yaml"))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log = lambda s: print(s, flush=True)
    for v in a.variants:
        run(v, a.init, cfg, device, log)


if __name__ == "__main__":
    main()
