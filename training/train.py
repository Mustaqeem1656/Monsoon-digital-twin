"""Train the monsoon stepper.   python -m training.train [--config training/config.yaml] [--smoke]

Stage A: 1-day-ahead training. Stage B: autoregressive rollouts of growing length (2 -> 4 -> 8 days) with backprop
through the whole rollout, so the model learns to stay stable on its own outputs.
Loss = latitude-weighted MSE in normalised units (heavy rain upweighted) + a spatial-variance (anti-blur) term.
"""
from __future__ import annotations
import argparse, copy, math, random, sys, time
from pathlib import Path

import numpy as np
import torch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from eval.baselines import load_data, load_std      # noqa: E402
from model.net import MonsoonNet, RAIN              # noqa: E402
from monsoon_r1.contract import LAT                 # noqa: E402


def set_seed(s):
    random.seed(s); np.random.seed(s); torch.manual_seed(s); torch.cuda.manual_seed_all(s)


def build_model(cfg, data, dates, static, std_phys):
    tr0, tr1 = cfg["data"]["train_years"]
    tr = np.array([tr0 <= d.year <= tr1 for d in dates])
    x = data[tr].astype("f8")
    mean = x.mean(axis=(0, 2, 3)); std = x.std(axis=(0, 2, 3))
    lr_ = np.log1p(np.clip(x[:, RAIN], 0, None)); mean[RAIN], std[RAIN] = lr_.mean(), lr_.std()
    oro = static[1]; st = np.stack([static[0], (oro - oro.mean()) / oro.std()]).astype("f4")
    return MonsoonNet(cfg["model"]["width"], cfg["model"]["n_blocks"], static=st, lat=LAT, mean=mean, std=std)


class Windows:
    """All valid start indices t (last input day) whose inputs t-2..t and targets t+1..t+H lie inside the year range."""
    def __init__(self, dates, years, every=1):
        y0, y1 = years; self.dates = dates
        inside = np.array([y0 <= d.year <= y1 for d in dates])
        self.inside = inside; self.every = every

    def starts(self, horizon):
        n = len(self.dates)
        return [t for t in range(2, n - horizon) if self.inside[t - 2] and self.inside[t + horizon]][::self.every]


def doy_angle(dates, idx):
    return torch.tensor([2 * math.pi * dates[t].timetuple().tm_yday / 365.0 for t in idx], dtype=torch.float32)


def batch(Z, idx, horizon, dates, device):
    i = torch.as_tensor(idx)
    inp = torch.stack([Z[i - 2], Z[i - 1], Z[i]], 1)                      # [B,3,6,H,W]
    tgt = torch.stack([Z[i + k] for k in range(1, horizon + 1)], 1)      # [B,h,6,H,W]
    return inp.to(device), tgt.to(device), doy_angle(dates, idx).to(device)


def loss_fn(model, pred, tgt, cfg, std_phys):
    """pred/tgt [B,h,6,H,W] normalised model space."""
    L = cfg["loss"]
    w_lat = model.lat_w                                                   # [H,1]
    cw = torch.ones(6, device=pred.device); cw[RAIN] = L["rain_channel_weight"]
    rain_true_mm = torch.expm1((tgt[:, :, RAIN] * model.std[RAIN] + model.mean[RAIN]).clamp(min=0))
    wmap = torch.ones_like(tgt); wmap[:, :, RAIN] = 1 + L["rain_heavy_weight"] * (rain_true_mm > L["rain_heavy_mm"]).float()
    mse = ((pred - tgt) ** 2 * wmap * w_lat * cw[:, None, None]).mean()
    # anti-blur: compare spatial variance of each map in PHYSICAL units / std (what the judge measures)
    s = std_phys[:, None, None]
    pp, tt = model.decode(pred.float()) / s, model.decode(tgt.float()) / s
    vp, vt = pp.flatten(-2).var(-1), tt.flatten(-2).var(-1)
    var = ((torch.log(vp + 1e-4) - torch.log(vt + 1e-4)) ** 2).mean()
    return mse + L["variance_weight"] * var, mse.item(), var.item()


@torch.no_grad()
def validate(model, Z, starts, dates, steps, device, bs=64):
    model.eval(); tot, n = 0.0, 0
    for k in range(0, len(starts), bs):
        idx = starts[k:k + bs]; inp, tgt, ang = batch(Z, idx, steps, dates, device)
        pred = model.rollout(inp, ang, steps)
        tot += ((pred - tgt) ** 2 * model.lat_w).mean().item() * len(idx); n += len(idx)
    model.train(); return tot / max(n, 1)


def run_stage(name, model, Z, dates, cfg, horizon, epochs, lr, bs, tr_win, val_starts, std_phys, device, best, log):
    starts = tr_win.starts(horizon)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    nb = len(starts) // bs
    mb = cfg.get("max_batches_per_epoch") or 0
    if mb: nb = min(nb, mb)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=max(epochs * nb, 1), pct_start=0.05)
    use_amp = cfg["amp"] and device == "cuda"
    for ep in range(1, epochs + 1):
        t0 = time.time(); perm = np.random.permutation(starts); tl = tm = tv = 0.0
        for b in range(nb):
            idx = perm[b * bs:(b + 1) * bs].tolist()
            inp, tgt, ang = batch(Z, idx, horizon, dates, device)
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=use_amp):
                pred = model.rollout(inp, ang, horizon, noise_std=cfg["loss"]["input_noise"])
            loss, m, v = loss_fn(model, pred.float(), tgt, cfg, std_phys)
            opt.zero_grad(set_to_none=True); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); sched.step()
            tl += loss.item(); tm += m; tv += v
        vl = validate(model, Z, val_starts, dates, cfg["val_rollout_steps"], device)
        flag = ""
        if vl < best["val"]:
            best.update(val=vl, state=copy.deepcopy(model.state_dict()), where=f"{name} ep{ep}"); flag = "  *best*"
            save(model, best["state"], cfg)
        log(f"[{name}] epoch {ep:3d}/{epochs}  train loss {tl / max(nb, 1):.4f} (mse {tm / max(nb, 1):.4f}, var {tv / max(nb, 1):.4f})"
            f"  val {cfg['val_rollout_steps']}-day mse {vl:.4f}  {time.time() - t0:6.1f}s{flag}")


def save(model, state, cfg):
    out = ROOT / cfg["out"]; out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"arch": {"width": model.width, "n_blocks": model.n_blocks}, "state_dict": state}, out)


def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--config", default=str(ROOT / "training" / "config.yaml"))
    ap.add_argument("--smoke", action="store_true", help="1 epoch per stage, 3 batches, to prove the pipeline works")
    ap.add_argument("--out", help="override the checkpoint path")
    a = ap.parse_args(argv)
    cfg = yaml.safe_load(open(a.config))
    if a.out: cfg["out"] = a.out
    if a.smoke:
        cfg["max_batches_per_epoch"] = 3; cfg["stage_a"]["epochs"] = 1; cfg["stage_b"]["epochs_per_horizon"] = [1] * len(cfg["stage_b"]["horizons"])
        cfg["data"]["val_every_nth"] = 30
    set_seed(cfg["seed"])
    device = cfg["device"] if (cfg["device"] != "cuda" or torch.cuda.is_available()) else "cpu"
    print(f"device: {device}" + (f" ({torch.cuda.get_device_name(0)})" if device == "cuda" else ""))

    data, dates, static = load_data(); std_phys_np = load_std()
    model = build_model(cfg, data, dates, static, std_phys_np).to(device)
    print(f"model: {sum(p.numel() for p in model.parameters()) / 1e6:.2f} M params, receptive radius {model.receptive_radius} cells/day")
    if model.receptive_radius > 8:
        print("WARNING: receptive radius > 8 cells/day; shocks may break the judge's speed limit")
    with torch.no_grad():
        Z = model.encode(torch.as_tensor(data).to(device))               # whole archive in model space, on the GPU (~170 MB)
    std_phys = torch.as_tensor(std_phys_np, device=device)
    tr_win = Windows(dates, cfg["data"]["train_years"])
    val_starts = Windows(dates, cfg["data"]["val_years"], cfg["data"]["val_every_nth"]).starts(cfg["val_rollout_steps"])
    best = {"val": float("inf"), "state": None, "where": ""}
    log = lambda s: print(s, flush=True)
    t_all = time.time()

    A = cfg["stage_a"]
    run_stage("A h=1", model, Z, dates, cfg, 1, A["epochs"], A["lr"], A["batch_size"], tr_win, val_starts, std_phys, device, best, log)
    B = cfg["stage_b"]
    for h, ep, bs in zip(B["horizons"], B["epochs_per_horizon"], B["batch_size"]):
        run_stage(f"B h={h}", model, Z, dates, cfg, h, ep, B["lr"], bs, tr_win, val_starts, std_phys, device, best, log)
    print(f"\ntraining done in {(time.time() - t_all) / 60:.1f} min; best checkpoint: {best['where']} "
          f"(val mse {best['val']:.4f}) -> {cfg['out']}")

    if cfg.get("grade_after", True):
        from eval import local_grader, impulse
        from model import inference
        inference.WEIGHTS = ROOT / cfg["out"]; inference._MODEL = None
        impulse.report(inference.get_model())
        local_grader.grade(local_grader.func_caller("model.inference:simulate"))
        local_grader.repo_scan_report()


if __name__ == "__main__":
    main()
