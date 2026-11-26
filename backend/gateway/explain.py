"""Explanation generator for the impact tiles: fixed sentence templates, no language model, deterministic.

Each explanation is 2-4 sentences: what changed, where, on which day, how big compared with the tile's documented
thresholds, which channel drove it, and the ensemble confidence. EVERY number written comes from the tile or its
confidence block (the test re-reads the text and checks each number against the API response); templates themselves
contain no digits.
"""
from __future__ import annotations


def n(x) -> str:
    return str(int(x)) if isinstance(x, int) else f"{x:.1f}"


def _states(t) -> str:
    s = [x["state"] for x in t["top_states"]]
    return "no Indian state in particular" if not s else s[0] if len(s) == 1 else ", ".join(s[:-1]) + " and " + s[-1]


def _spot(t) -> str:
    h = t["hotspots"][0] if t["hotspots"] else None
    return f"; the single most affected cell on day {n(t['day'])} is near {n(h['lat'])}°N {n(h['lon'])}°E" if h else ""


def _vs_threshold(t, v, level=None) -> str:
    thr, lv, u = t["thresholds"], t["levels"], t["unit"]
    if t["higher_is_worse"]:
        nxt = [(x, lv[k + 1]) for k, x in enumerate(thr) if v < x]
        if nxt:
            return f"{n(v)} {u} is below the {nxt[0][1]} threshold of {n(nxt[0][0])} {u}"
        top = f"{n(v)} {u} is at or above the {lv[len(thr)]} threshold of {n(thr[-1])} {u}"
        if t["id"] == "heat" and lv[len(thr)] == "High" and level == "Severe":
            top += f", and a cell that hot also reaches a daily mean of {n(t['severe_t2m_C'])} °C, which makes it Severe"
        return top
    nxt = [(x, lv[k + 1]) for k, x in enumerate(thr) if v >= x]
    if nxt:
        return f"{n(v)} {u} is not yet {nxt[0][1]} ({nxt[0][1]} means below {n(nxt[0][0])} {u})"
    return f"{n(v)} {u} is in the {lv[len(thr)]} range (below {n(thr[-1])} {u})"


def _conf(t, c, has_change) -> str:
    if not c:
        return ""
    if has_change:
        word = {"up": "goes up", "down": "goes down", "none": "does not change"}[t["direction"]]
        return f"Confidence: {n(c['same_direction'])} of {n(c['members'])} ensemble members ({n(c['same_direction_pct'])}%) agree it {word}."
    return f"Confidence: {n(c['same_level'])} of {n(c['members'])} ensemble members ({n(c['same_level_pct'])}%) give the same {t['branch']['level']} level."


def explain(t: dict, conf: dict | None, has_change: bool) -> list[str]:
    if not t["active"]:
        return [t["reason"][0].upper() + t["reason"][1:] + "."]
    name, u, p, b = t["name"], t["unit"], t["prime"], t["branch"]
    out = []
    if not has_change:
        v, d, lv = n(p["value"]), n(t["day"]), p["level"]
        out.append({"flood": f"Flood risk on the plain forecast: the wettest cell reaches {v} {u} on day {d}, level {lv}.",
                    "heat": f"Heat stress on the plain forecast: the largest temperature anomaly is {v} {u} on day {d}, level {lv}.",
                    "crop": f"Crop-water stress on the plain forecast: {v} {u} of cropland ends the forecast with a rain deficit of half or more, level {lv}.",
                    "solar": f"Solar on the plain forecast: clear, dry days cover {v} {u} of India land on average (fewest on day {d}), solar-loss level {lv}.",
                    "wind": f"Wind power on the plain forecast averages {v} {u} over India land (highest on day {d}), level {lv}."}[t["id"]])
        out.append(f"Most affected over the whole forecast: {_states(t)}{_spot(t)}.")
        out.append(_vs_threshold(t, p["value"], p["level"])[0].upper() + _vs_threshold(t, p["value"], p["level"])[1:] + ".")
    elif not t["changed"]:
        out.append(f"No change: with this change {name.lower()} stays at {n(b['value'])} {u} ({b['level']}), identical to the plain forecast.")
    else:
        if t["direction"] == "none":
            out.append(f"Little change: {name.lower()} moves from {n(p['value'])} to {n(b['value'])} {u} (delta {n(t['delta'])}), "
                       f"inside the no-change margin of {n(t['no_change_margin'])} {u}; level stays {b['level']}.")
        else:
            verb = "rises" if t["direction"] == "up" else "falls"
            lv = f"level stays {b['level']}" if p["level"] == b["level"] else f"level goes from {p['level']} to {b['level']}"
            out.append(f"{name} {verb} from {n(p['value'])} to {n(b['value'])} {u} (delta {n(t['delta'])}) with the change; {lv}.")
        out.append(f"The biggest difference is on day {n(t['day'])} over {_states(t)}{_spot(t)}; "
                   + _vs_threshold(t, b["value"], b["level"]) + ".")
        cz = t["cause"]
        if cz:
            also = f"; also {cz['also']['name']} ({n(cz['also']['mean_change'])} {cz['also']['unit']})" if cz.get("also") else ""
            out.append(f"Main driver: {cz['name']} ({n(cz['mean_change'])} {cz['unit']} on average over the most-changed cells on day {n(cz['day'])}){also}.")
    s = _conf(t, conf, has_change)
    if s:
        out.append(s)
    return out
