// JPL Keplerian elements (Standish, valid 1800-2050) + Schlyter lunar theory; checked against Astropy
// (< 0.1 deg planets, < 0.5 deg Moon). Lifted unchanged from the approved mockup.
export const EL = {
  Mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  Venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  EM: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  Mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  Jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  Saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  Uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  Neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
};
export const PLANETS = [
  { n: 'Mercury', r: 1.1, t: 'mercury.jpg' }, { n: 'Venus', r: 1.7, t: 'venus.jpg' }, { n: 'Mars', r: 1.4, t: 'mars.jpg' },
  { n: 'Jupiter', r: 3.4, t: 'jupiter.jpg' }, { n: 'Saturn', r: 2.9, t: 'saturn.jpg', ring: true },
  { n: 'Uranus', r: 2.0, t: 'uranus.jpg' }, { n: 'Neptune', r: 2.0, t: 'neptune.jpg' },
];
const RAD0 = Math.PI / 180;
export const sd = x => Math.sin(x * RAD0), cd = x => Math.cos(x * RAD0);
export function jd(date) { return date.getTime() / 86400000 + 2440587.5; }
export function helio(nm, T, Mfix) {
  const [e0, r] = EL[nm]; const [a, e, I, L, w, O] = e0.map((x, k) => x + r[k] * T);
  const M = Mfix !== undefined ? Mfix : ((L - w + 180) % 360 + 360) % 360 - 180, om = w - O, ed = e / RAD0;
  let E = M + ed * sd(M); for (let k = 0; k < 8; k++) E += (M - (E - ed * sd(E))) / (1 - e * cd(E));
  const xp = a * (cd(E) - e), yp = a * Math.sqrt(1 - e * e) * sd(E);
  return [(cd(om) * cd(O) - sd(om) * sd(O) * cd(I)) * xp + (-sd(om) * cd(O) - cd(om) * sd(O) * cd(I)) * yp,
    (cd(om) * sd(O) + sd(om) * cd(O) * cd(I)) * xp + (-sd(om) * sd(O) + cd(om) * cd(O) * cd(I)) * yp,
    (sd(om) * sd(I)) * xp + (cd(om) * sd(I)) * yp];
}
export function toEq(v) { const ob = 23.43928; return [v[0], v[1] * cd(ob) - v[2] * sd(ob), v[1] * sd(ob) + v[2] * cd(ob)]; }
export function moonEcl(d) {
  const N = 125.1228 - 0.0529538083 * d, i = 5.1454, w = 318.0634 + 0.1643573223 * d, e = 0.0549, M = ((115.3654 + 13.0649929509 * d) % 360 + 360) % 360, ed = e / RAD0;
  let E = M + ed * sd(M) * (1 + e * cd(M)); for (let k = 0; k < 5; k++) E -= (E - ed * sd(E) - M) / (1 - e * cd(E));
  const xv = cd(E) - e, yv = Math.sqrt(1 - e * e) * sd(E), v = Math.atan2(yv, xv) / RAD0, r = Math.hypot(xv, yv);
  const x = r * (cd(N) * cd(v + w) - sd(N) * sd(v + w) * cd(i)), y = r * (sd(N) * cd(v + w) + cd(N) * sd(v + w) * cd(i)), z = r * sd(v + w) * sd(i);
  let lon = Math.atan2(y, x) / RAD0, lat = Math.atan2(z, Math.hypot(x, y)) / RAD0;
  const Ms = 356.0470 + 0.9856002585 * d, Ls = Ms + 282.9404 + 4.70935e-5 * d, Lm = N + w + M, D = Lm - Ls, F = Lm - N, Mm = M;
  lon += -1.274 * sd(Mm - 2 * D) + 0.658 * sd(2 * D) - 0.186 * sd(Ms) - 0.059 * sd(2 * Mm - 2 * D) - 0.057 * sd(Mm - 2 * D + Ms) + 0.053 * sd(Mm + 2 * D) + 0.046 * sd(2 * D - Ms) + 0.041 * sd(Mm - Ms) - 0.035 * sd(D) - 0.031 * sd(Mm + Ms);
  lat += -0.173 * sd(F - 2 * D) - 0.055 * sd(Mm - F - 2 * D) - 0.046 * sd(Mm + F - 2 * D) + 0.033 * sd(F + 2 * D) + 0.017 * sd(2 * Mm + F);
  return [cd(lat) * cd(lon), cd(lat) * sd(lon), sd(lat)];
}
export function sky(date) {
  const J = jd(date), T = (J - 2451545.0) / 36525, em = helio('EM', T), out = {};
  const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
  out.Sun = toEq(em.map(x => -x)); out.Moon = unit(toEq(moonEcl(J - 2451543.5))); out.T = T; out.em = em;
  PLANETS.forEach(p => { const h = helio(p.n, T); out[p.n] = toEq(h.map((x, k) => x - em[k])); });
  out.gmst = ((280.46061837 + 360.98564736629 * (J - 2451545.0)) % 360 + 360) % 360;
  return out;
}
