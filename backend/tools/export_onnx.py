"""Export weights/model.pt -> weights/model.onnx (one network step) + weights/norm.json, and check both backends agree.
  python backend/tools/export_onnx.py        (laptop only; needs the `onnx` package for export)
"""
from __future__ import annotations
import json, sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend.model.net import MonsoonNet                       # noqa: E402
from backend.model import runtime as R                         # noqa: E402

OPSET = 17


class Step(torch.nn.Module):
    def __init__(self, m):
        super().__init__(); self.m = m

    def forward(self, z3, angle):
        return self.m.step(z3, angle)


def main():
    check_only = "--check" in sys.argv
    ck = torch.load(R.WEIGHTS_DIR / "model.pt", map_location="cpu", weights_only=False)
    m = MonsoonNet(**ck["arch"]); m.load_state_dict(ck["state_dict"]); m.eval()
    norm = {"model_name": f"monsoon-resconv-w{m.width}-b{m.n_blocks}",
            "mean": m.mean.tolist(), "std": m.std.tolist(), "rain_space": "log1p"}
    if not check_only:
        R.NORM_FILE.write_text(json.dumps(norm, indent=1))
        z3 = torch.zeros(1, 3, 6, 32, 36); ang = torch.zeros(1)
        torch.onnx.export(Step(m), (z3, ang), str(R.WEIGHTS_DIR / "model.onnx"), input_names=["z3", "angle"],
                          output_names=["z"], opset_version=OPSET, dynamo=False)
        print(f"wrote {R.WEIGHTS_DIR / 'model.onnx'} (opset {OPSET}) and {R.NORM_FILE}")
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        print("onnxruntime not installed here: run  python backend/tools/export_onnx.py --check  in a venv that has it"); return

    # agreement check on a real-looking state: 10-step rollouts through both backends
    rng = np.random.default_rng(1)
    base = np.array([295.0, 4.0, 2.0, 1.0, 100800.0, 35.0], "f4")[None, :, None, None]
    x = (base + rng.normal(0, 1, (3, 6, 32, 36)) * np.array([3, 3, 2, 2, 300, 8])[None, :, None, None]).astype("f4")
    x[:, 1] = np.abs(x[:, 1])
    a, _ = R.Engine(R.TorchBackend(), norm["mean"], norm["std"]).simulate(x, [0.5, 0.86], 10)
    b, _ = R.Engine(R.OnnxBackend(), norm["mean"], norm["std"]).simulate(x, [0.5, 0.86], 10)
    std = np.array([13.46, 7.55, 2.90, 2.43, 619.0, 20.49], "f4")[None, :, None, None]   # stats.json std (data/ may be absent)
    d = np.abs(a - b) / std
    print(f"torch vs onnx, 10-step rollout: max |diff| = {d.max():.2e} std (mean {d.mean():.2e})")
    assert d.max() < 1e-3, "backends disagree"


if __name__ == "__main__":
    main()
