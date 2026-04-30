// ─────────────────────────────────────────────────────────────────────────────
// GeoScheduler Frontend — geo-scheduler-full.jsx
// Connects to backend: Geocoding auto-fill, Twilio SMS, Bland.ai live feed
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useEffect, useCallback, useRef } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

// ── Geo math ─────────────────────────────────────────────────────────────────
function haversine(a, b) {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function kmeans(points, k, iters = 40) {
  if (!points.length) return [];
  k = Math.min(k, points.length);
  let centroids = points.slice(0, k).map((p) => ({ lat: p.lat, lng: p.lng }));
  let asgn = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    asgn = points.map((p) => {
      let b = 0, bd = Infinity;
      centroids.forEach((c, i) => { const d = haversine(p, c); if (d < bd) { bd = d; b = i; } });
      return b;
    });
    centroids = centroids.map((_, i) => {
      const m = points.filter((_, j) => asgn[j] === i);
      if (!m.length) return centroids[i];
      return { lat: m.reduce((s, p) => s + p.lat, 0) / m.length, lng: m.reduce((s, p) => s + p.lng, 0) / m.length };
    });
  }
  return asgn;
}

function optimizeRoute(pts) {
  if (pts.length <= 1) return pts;
  const vis = new Set(), route = [];
  let cur = pts[0]; vis.add(0); route.push(cur);
  while (route.length < pts.length) {
    let best = null, bd = Infinity;
    pts.forEach((p, i) => { if (!vis.has(i)) { const d = haversine(cur, p); if (d < bd) { bd = d; best = i; } } });
    vis.add(best); cur = pts[best]; route.push(cur);
  }
  return route;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const COLORS = [
  { bg: "#F59E0B", name: "Zone A" },
  { bg: "#6366F1", name: "Zone B" },
  { bg: "#10B981", name: "Zone C" },
  { bg: "#EF4444", name: "Zone D" },
  { bg: "#EC4899", name: "Zone E" },
];
const TIMES = ["8:00 AM", "9:30 AM", "11:00 AM", "1:00 PM", "2:30 PM", "4:00 PM", "5:30 PM"];
const TODAY = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const fnt = "'DM Mono', 'Courier New', monospace";
const card = { background: "#0a0e1a", border: "1px solid #1e293b", borderRadius: 8, padding: "10px 12px" };

// ── Sub-components ────────────────────────────────────────────────────────────
function Badge({ score }) {
  const c = score >= 9 ? "#10B981" : score >= 7 ? "#F59E0B" : "#6B7280";
  return (
    <span style={{ background: c + "22", color: c, border: `1px solid ${c}55`, borderRadius: 4, fontSize: 10, fontWeight: 700, padding: "1px 6px", fontFamily: fnt }}>
      {score}/10
    </span>
  );
}

function SourceBadge({ source }) {
  if (!source || source === "manual") return null;
  return (
    <span style={{ background: "#6366F122", color: "#818CF8", border: "1px solid #6366F155", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 6px", fontFamily: fnt, marginLeft: 4 }}>
      AI CALL
    </span>
  );
}

function Spinner() {
  return <span style={{ display: "inline-block", animation: "spin 1s linear infinite", fontSize: 14 }}>⟳</span>;
}

function Toast({ message, type }) {
  return message ? (
    <div style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 999,
      background: type === "success" ? "#10B98122" : "#EF444422",
      border: `1px solid ${type === "success" ? "#10B981" : "#EF4444"}`,
      color: type === "success" ? "#10B981" : "#EF4444",
      borderRadius: 8, padding: "12px 18px", fontSize: 12, fontFamily: fnt,
      maxWidth: 320, lineHeight: 1.6,
    }}>{message}</div>
  ) : null;
}

function MapSVG({ leads, asgn, k, sel, onSel }) {
  const geo = leads.filter((l) => l.lat && l.lng);
  if (!geo.length) return (
    <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", background: "#060913", borderRadius: 8, fontSize: 12, color: "#334155" }}>
      No geocoded leads yet — add an address to see the map
    </div>
  );
  const lats = geo.map((l) => l.lat), lngs = geo.map((l) => l.lng);
  const minLat = Math.min(...lats) - 0.025, maxLat = Math.max(...lats) + 0.025;
  const minLng = Math.min(...lngs) - 0.025, maxLng = Math.max(...lngs) + 0.025;
  const W = 520, H = 280;
  const proj = (lat, lng) => ({
    x: ((lng - minLng) / (maxLng - minLng)) * W,
    y: H - ((lat - minLat) / (maxLat - minLat)) * H,
  });
  const clusters = Array.from({ length: k }, () => []);
  geo.forEach((l) => { const i = leads.indexOf(l); if (asgn[i] !== undefined && clusters[asgn[i]]) clusters[asgn[i]].push(l); });

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: "#060913", display: "block" }}>
      {[0.25, 0.5, 0.75].map((t) => [
        <line key={"v" + t} x1={t * W} y1={0} x2={t * W} y2={H} stroke="#0f172a" strokeWidth={1} />,
        <line key={"h" + t} x1={0} y1={t * H} x2={W} y2={t * H} stroke="#0f172a" strokeWidth={1} />,
      ])}
      {clusters.map((mem, ci) => {
        if (!mem.length) return null;
        const col = COLORS[ci % COLORS.length];
        const pts = mem.map((l) => proj(l.lat, l.lng));
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        const maxR = Math.max(28, ...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))) + 18;
        const isSel = sel === ci;
        return (
          <circle key={"z" + ci} cx={cx} cy={cy} r={maxR}
            fill={col.bg + (isSel ? "30" : "15")} stroke={col.bg}
            strokeWidth={isSel ? 2 : 1} strokeDasharray={isSel ? "none" : "4 3"}
            style={{ cursor: "pointer" }} onClick={() => onSel(isSel ? null : ci)} />
        );
      })}
      {sel !== null && (() => {
        const mem = geo.filter((l) => asgn[leads.indexOf(l)] === sel);
        const route = optimizeRoute(mem);
        const col = COLORS[sel % COLORS.length];
        return route.slice(0, -1).map((l, i) => {
          const f = proj(l.lat, l.lng), t2 = proj(route[i + 1].lat, route[i + 1].lng);
          return <line key={"r" + i} x1={f.x} y1={f.y} x2={t2.x} y2={t2.y} stroke={col.bg} strokeWidth={1.5} strokeDasharray="5 3" opacity={0.75} />;
        });
      })()}
      {clusters.map((mem, ci) => {
        if (!mem.length) return null;
        const col = COLORS[ci % COLORS.length];
        const pts = mem.map((l) => proj(l.lat, l.lng));
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        const maxR = Math.max(28, ...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))) + 18;
        return (
          <text key={"lbl" + ci} x={cx} y={cy - maxR - 6} textAnchor="middle"
            style={{ fontSize: 10, fontWeight: 700, fill: col.bg, fontFamily: fnt, letterSpacing: ".1em" }}>
            {col.name}
          </text>
        );
      })}
      {geo.map((l) => {
        const i = leads.indexOf(l);
        const { x, y } = proj(l.lat, l.lng);
        const col = COLORS[(asgn[i] ?? 0) % COLORS.length];
        const dim = sel !== null && asgn[i] !== sel;
        return (
          <g key={l.id} style={{ cursor: "pointer" }} onClick={() => onSel(asgn[i])}>
            <circle cx={x} cy={y} r={9} fill={col.bg} opacity={dim ? 0.2 : 1} stroke="#060913" strokeWidth={1.5} />
            <text x={x} y={y + 4} textAnchor="middle"
              style={{ fontSize: 8, fontWeight: 700, fill: "#060913", fontFamily: "monospace", opacity: dim ? 0.2 : 1, userSelect: "none" }}>
              {l.score}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function GeoScheduler() {
  const [leads, setLeads] = useState([]);
  const [k, setK] = useState(3);
  const [sel, setSel] = useState(null);
  const [view, setView] = useState("map");
  const [sched, setSched] = useState({});
  const [toast, setToast] = useState({ message: "", type: "success" });
  const [loading, setLoading] = useState({ leads: true, sms: false, geocode: false });
  const pollRef = useRef(null);

  // ── Form state ──────────────────────────────────────────────────────────────
  const [form, setForm] = useState({ name: "", address: "", phone: "", notes: "", score: 8 });
  const [geocoding, setGeocoding] = useState(false);
  const [geoResult, setGeoResult] = useState(null); // { lat, lng, formatted_address }

  const showToast = (message, type = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast({ message: "", type: "success" }), 4000);
  };

  // ── Load leads from backend ─────────────────────────────────────────────────
  const fetchLeads = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/leads`);
      const data = await r.json();
      setLeads(data);
    } catch (e) {
      console.error("Failed to load leads:", e);
    } finally {
      setLoading((p) => ({ ...p, leads: false }));
    }
  }, []);

  useEffect(() => {
    fetchLeads();
    // Poll every 15s for new Bland.ai leads
    pollRef.current = setInterval(fetchLeads, 15000);
    return () => clearInterval(pollRef.current);
  }, [fetchLeads]);

  // ── Clustering ──────────────────────────────────────────────────────────────
  const geoLeads = useMemo(() => leads.filter((l) => l.lat && l.lng), [leads]);
  const asgn = useMemo(() => {
    const a = kmeans(geoLeads, k);
    // Map back to full leads array (non-geocoded get cluster 0)
    return leads.map((l) => {
      const gi = geoLeads.indexOf(l);
      return gi >= 0 ? a[gi] : 0;
    });
  }, [leads, geoLeads, k]);

  const clusters = useMemo(() => {
    const c = Array.from({ length: k }, () => []);
    geoLeads.forEach((l) => { const i = leads.indexOf(l); if (c[asgn[i]]) c[asgn[i]].push(l); });
    return c;
  }, [geoLeads, leads, asgn, k]);

  const selLeads = useMemo(
    () => sel !== null ? geoLeads.filter((l) => asgn[leads.indexOf(l)] === sel) : [],
    [geoLeads, leads, asgn, sel]
  );
  const route = useMemo(() => optimizeRoute([...selLeads]), [selLeads]);

  function totalMi(mem) {
    const r = optimizeRoute([...mem]);
    let d = 0; for (let i = 0; i < r.length - 1; i++) d += haversine(r[i], r[i + 1]);
    return d;
  }
  const mi = sel !== null ? totalMi(selLeads) : 0;
  const driveMins = Math.round((mi / 28) * 60);
  const col = sel !== null ? COLORS[sel % COLORS.length] : null;

  // ── 1. GEOCODE address ──────────────────────────────────────────────────────
  async function handleGeocode() {
    if (!form.address.trim()) return;
    setGeocoding(true);
    setGeoResult(null);
    try {
      const r = await fetch(`${API}/api/geocode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: form.address }),
      });
      if (!r.ok) throw new Error("Address not found");
      const data = await r.json();
      setGeoResult(data);
      setForm((p) => ({ ...p, address: data.formatted_address }));
      showToast(`✓ Found: ${data.formatted_address}`);
    } catch (e) {
      showToast(`✗ ${e.message}`, "error");
    } finally {
      setGeocoding(false);
    }
  }

  // ── 2. ADD LEAD ─────────────────────────────────────────────────────────────
  async function handleAddLead() {
    if (!form.name || !form.address) return showToast("Name and address required", "error");
    try {
      const body = { ...form, score: +form.score, ...(geoResult ?? {}) };
      const r = await fetch(`${API}/api/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Failed to add");
      const newLead = await r.json();
      setLeads((p) => [...p, newLead]);
      setForm({ name: "", address: "", phone: "", notes: "", score: 8 });
      setGeoResult(null);
      setView("map");
      showToast(`✓ ${newLead.name} added to map`);
    } catch (e) {
      showToast(`✗ ${e.message}`, "error");
    }
  }

  // ── 3. TWILIO SMS ───────────────────────────────────────────────────────────
  async function handleSendSMS() {
    const scheduled = route.filter((l) => sched[l.id]);
    if (!scheduled.length) return showToast("Assign at least one time slot first", "error");

    setLoading((p) => ({ ...p, sms: true }));
    try {
      const appointments = scheduled.map((l) => ({
        name: l.name,
        phone: l.phone,
        time: sched[l.id],
        date: TODAY,
        address: l.address,
      }));

      const r = await fetch(`${API}/api/sms/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointments }),
      });
      const data = await r.json();

      if (data.sent > 0) {
        showToast(`✓ ${data.sent} SMS confirmation${data.sent > 1 ? "s" : ""} sent! ${data.failed ? `(${data.failed} failed)` : ""}`);
        // Mark leads as confirmed
        scheduled.forEach((l) => {
          fetch(`${API}/api/leads/${l.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "confirmed" }),
          });
        });
        setLeads((p) => p.map((l) => scheduled.find((s) => s.id === l.id) ? { ...l, status: "confirmed" } : l));
      } else {
        showToast(`✗ All SMS failed — check Twilio config`, "error");
      }
    } catch (e) {
      showToast(`✗ SMS error: ${e.message}`, "error");
    } finally {
      setLoading((p) => ({ ...p, sms: false }));
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const blandNew = leads.filter((l) => l.source === "bland_ai" && l.status === "new");

  return (
    <div style={{ fontFamily: fnt, background: "#0a0e1a", color: "#e2e8f0", minHeight: "100vh" }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>

      {/* ── Header ── */}
      <div style={{ background: "#060913", borderBottom: "1px solid #1e293b", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, color: "#F59E0B", letterSpacing: ".14em", fontWeight: 700 }}>◈ GEO-ROUTE SCHEDULER</div>
          <div style={{ fontSize: 10, color: "#334155", letterSpacing: ".06em", marginTop: 2 }}>
            {leads.length} LEADS · {k} ZONES
            {blandNew.length > 0 && (
              <span style={{ marginLeft: 8, background: "#6366F122", color: "#818CF8", border: "1px solid #6366F155", borderRadius: 4, fontSize: 9, padding: "1px 7px", animation: "pulse 2s infinite" }}>
                +{blandNew.length} NEW FROM AI CALLS
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#475569", marginRight: 4 }}>ZONES:</span>
          {[2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => { setK(n); setSel(null); }}
              style={{ background: k === n ? "#F59E0B" : "#0f172a", color: k === n ? "#0a0e1a" : "#64748b", border: `1px solid ${k === n ? "#F59E0B" : "#1e293b"}`, borderRadius: 4, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: fnt }}>
              {n}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[["map", "◎ Map"], ["schedule", "⊞ Schedule"], ["add", "+ Lead"]].map(([v, lbl]) => (
            <button key={v} onClick={() => setView(v)}
              style={{ background: view === v ? "#1e293b" : "transparent", color: view === v ? "#e2e8f0" : "#475569", border: `1px solid ${view === v ? "#334155" : "#1e293b"}`, borderRadius: 6, padding: "4px 12px", fontSize: 10, fontFamily: fnt, cursor: "pointer", letterSpacing: ".06em", textTransform: "uppercase" }}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* ── MAP VIEW ── */}
      {view === "map" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", minHeight: "calc(100vh - 60px)" }}>
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {loading.leads ? (
              <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", background: "#060913", borderRadius: 8, fontSize: 12, color: "#475569" }}>
                <Spinner /> &nbsp; Loading leads…
              </div>
            ) : (
              <MapSVG leads={leads} asgn={asgn} k={k} sel={sel} onSel={setSel} />
            )}
            <div style={{ display: "flex", gap: 8 }}>
              {clusters.map((mem, ci) => {
                if (!mem.length) return null;
                const c = COLORS[ci % COLORS.length];
                const isSel = sel === ci;
                return (
                  <div key={ci} onClick={() => setSel(isSel ? null : ci)}
                    style={{ flex: 1, background: isSel ? c.bg + "1a" : "#060913", border: `1px solid ${isSel ? c.bg : "#1e293b"}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer", transition: "all .2s" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: c.bg, letterSpacing: ".1em", marginBottom: 4 }}>{c.name}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#e2e8f0", lineHeight: 1 }}>{mem.length}</div>
                    <div style={{ fontSize: 9, color: "#334155", marginTop: 3 }}>leads · ~{Math.round(totalMi(mem))}mi</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sidebar */}
          <div style={{ background: "#060913", borderLeft: "1px solid #1e293b", overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8, maxHeight: "calc(100vh - 60px)" }}>
            {sel === null ? (
              <>
                <div style={{ fontSize: 10, color: "#334155", letterSpacing: ".08em", marginBottom: 4 }}>ALL LEADS · CLICK ZONE</div>
                {leads.map((l, i) => (
                  <div key={l.id} onClick={() => l.lat && setSel(asgn[i])}
                    style={{ ...card, borderLeft: `3px solid ${COLORS[(asgn[i] ?? 0) % COLORS.length].bg}`, cursor: l.lat ? "pointer" : "default", opacity: l.lat ? 1 : 0.5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0", lineHeight: 1.3 }}>{l.name}</div>
                        {!l.lat && <div style={{ fontSize: 9, color: "#EF4444", marginTop: 2 }}>⚠ geocoding…</div>}
                      </div>
                      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        <Badge score={l.score} />
                        <SourceBadge source={l.source} />
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: "#334155", marginTop: 4 }}>{l.address}</div>
                    {l.status === "confirmed" && <div style={{ fontSize: 9, color: "#10B981", marginTop: 3 }}>✓ SMS confirmed</div>}
                  </div>
                ))}
              </>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: col.bg, letterSpacing: ".1em" }}>{col.name} · {selLeads.length} STOPS</div>
                  <button onClick={() => setSel(null)} style={{ background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer" }}>×</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[{ label: "Route miles", val: `${Math.round(mi)}mi` }, { label: "Drive time", val: `${driveMins}min` }, { label: "Avg score", val: (selLeads.reduce((s, l) => s + l.score, 0) / selLeads.length || 0).toFixed(1) }, { label: "Est revenue", val: `$${(selLeads.length * 1900 * 0.4).toLocaleString()}` }].map(({ label, val }) => (
                    <div key={label} style={{ ...card, padding: "8px 10px" }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>{val}</div>
                      <div style={{ fontSize: 10, color: "#334155" }}>{label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: "#334155", letterSpacing: ".06em" }}>OPTIMIZED ROUTE</div>
                {route.map((l, i) => (
                  <div key={l.id} style={card}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <div style={{ width: 18, height: 18, borderRadius: "50%", background: col.bg, color: "#060913", fontSize: 9, fontWeight: 700, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{i + 1}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0" }}>{l.name}</div>
                          <Badge score={l.score} />
                        </div>
                        <div style={{ fontSize: 9, color: "#334155", marginTop: 2 }}>{l.address}</div>
                        <div style={{ fontSize: 9, color: "#475569", marginTop: 2 }}>{l.notes}</div>
                        {i < route.length - 1 && <div style={{ fontSize: 9, color: "#1e3a5f", marginTop: 4 }}>↓ {haversine(l, route[i + 1]).toFixed(1)}mi to next</div>}
                      </div>
                    </div>
                  </div>
                ))}
                <button onClick={() => setView("schedule")}
                  style={{ background: col.bg, color: "#060913", border: "none", borderRadius: 6, padding: "9px 14px", fontFamily: fnt, fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: ".06em", marginTop: 4 }}>
                  ⊞ BUILD DAY SCHEDULE →
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── SCHEDULE VIEW ── */}
      {view === "schedule" && (
        <div style={{ padding: 16, maxWidth: 860, margin: "0 auto" }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: "#334155", letterSpacing: ".1em", marginBottom: 8 }}>SELECT ZONE TO SCHEDULE</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {clusters.map((mem, ci) => {
                if (!mem.length) return null;
                const c = COLORS[ci % COLORS.length];
                return (
                  <button key={ci} onClick={() => setSel(ci)}
                    style={{ background: sel === ci ? c.bg : "#060913", color: sel === ci ? "#060913" : c.bg, border: `1px solid ${c.bg}`, borderRadius: 6, padding: "5px 14px", fontFamily: fnt, fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: ".06em" }}>
                    {c.name} ({mem.length})
                  </button>
                );
              })}
            </div>
          </div>

          {sel !== null && (
            <>
              <div style={{ fontSize: 10, color: "#334155", letterSpacing: ".08em", marginBottom: 10 }}>
                ASSIGN TIME SLOTS · {col.name} · {TODAY}
              </div>
              <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #1e293b" }}>
                <div style={{ display: "grid", gridTemplateColumns: "24px 1fr 90px 130px 80px", background: "#060913", padding: "7px 12px", fontSize: 9, color: "#334155", letterSpacing: ".08em", borderBottom: "1px solid #1e293b" }}>
                  {"# LEAD SCORE TIME SLOT DRIVE".split(" ").map((h) => <div key={h}>{h}</div>)}
                </div>
                {route.map((l, i) => (
                  <div key={l.id} style={{ display: "grid", gridTemplateColumns: "24px 1fr 90px 130px 80px", padding: "10px 12px", background: i % 2 === 0 ? "#0a0e1a" : "#07090f", borderBottom: "1px solid #0f172a", alignItems: "center" }}>
                    <div style={{ fontSize: 11, color: col.bg, fontWeight: 700 }}>{i + 1}</div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0", display: "flex", alignItems: "center", gap: 6 }}>
                        {l.name}
                        <SourceBadge source={l.source} />
                        {l.status === "confirmed" && <span style={{ fontSize: 9, color: "#10B981" }}>✓ sent</span>}
                      </div>
                      <div style={{ fontSize: 9, color: "#334155" }}>{l.address}</div>
                      <div style={{ fontSize: 9, color: "#475569", marginTop: 2 }}>{l.notes}</div>
                    </div>
                    <Badge score={l.score} />
                    <select value={sched[l.id] || ""} onChange={(e) => setSched((p) => ({ ...p, [l.id]: e.target.value }))}
                      style={{ background: "#060913", color: "#e2e8f0", border: `1px solid ${sched[l.id] ? col.bg : "#1e293b"}`, borderRadius: 5, padding: "4px 8px", fontSize: 10, fontFamily: fnt, cursor: "pointer", width: "100%" }}>
                      <option value="">— assign —</option>
                      {TIMES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                    <div style={{ fontSize: 10, color: "#334155" }}>{i < route.length - 1 ? `${haversine(l, route[i + 1]).toFixed(1)}mi →` : "—"}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 14, background: "#060913", border: "1px solid #1e293b", borderRadius: 10, padding: "14px 18px", display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
                {[{ label: "SCHEDULED", val: `${Object.values(sched).filter(Boolean).length} / ${route.length}`, color: col.bg }, { label: "TOTAL DRIVE", val: `${Math.round(mi)}mi · ${driveMins}min`, color: "#e2e8f0" }, { label: "EST. COMMISSION", val: `$${(route.length * 1900 * 0.4).toLocaleString()}`, color: "#10B981" }]
                  .map(({ label, val, color }) => (
                    <div key={label}>
                      <div style={{ fontSize: 9, color: "#334155", letterSpacing: ".06em", marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color }}>{val}</div>
                    </div>
                  ))}
                <div style={{ flex: 1, minWidth: 140, textAlign: "right" }}>
                  <button onClick={handleSendSMS} disabled={loading.sms}
                    style={{ background: col.bg, color: "#060913", border: "none", borderRadius: 6, padding: "10px 18px", fontFamily: fnt, fontSize: 11, fontWeight: 700, cursor: loading.sms ? "wait" : "pointer", letterSpacing: ".06em", opacity: loading.sms ? 0.7 : 1 }}>
                    {loading.sms ? "⟳ Sending…" : "✓ CONFIRM & SEND SMS →"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── ADD LEAD VIEW ── */}
      {view === "add" && (
        <div style={{ padding: 20, maxWidth: 520, margin: "0 auto" }}>
          <div style={{ fontSize: 11, color: "#F59E0B", letterSpacing: ".1em", marginBottom: 14, fontWeight: 700 }}>+ NEW LEAD</div>
          <div style={{ background: "#060913", border: "1px solid #1e293b", borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>

            {[["name", "FULL NAME", "Margaret & Ron Holt"], ["phone", "PHONE", "+19015550000"], ["notes", "AI QUALIFIER NOTES", "Master bath, safety bars, strong budget"]].map(([key, label, ph]) => (
              <div key={key}>
                <div style={{ fontSize: 9, color: "#475569", letterSpacing: ".08em", marginBottom: 5 }}>{label}</div>
                <input value={form[key]} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))} placeholder={ph}
                  style={{ width: "100%", boxSizing: "border-box", background: "#0a0e1a", border: "1px solid #1e293b", color: "#e2e8f0", borderRadius: 6, padding: "8px 12px", fontSize: 11, fontFamily: fnt }} />
              </div>
            ))}

            {/* Address + geocode button */}
            <div>
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: ".08em", marginBottom: 5 }}>ADDRESS</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={form.address} onChange={(e) => { setForm((p) => ({ ...p, address: e.target.value })); setGeoResult(null); }}
                  placeholder="412 Bellevue Ct, Germantown, TN"
                  onKeyDown={(e) => e.key === "Enter" && handleGeocode()}
                  style={{ flex: 1, background: "#0a0e1a", border: `1px solid ${geoResult ? "#10B981" : "#1e293b"}`, color: "#e2e8f0", borderRadius: 6, padding: "8px 12px", fontSize: 11, fontFamily: fnt }} />
                <button onClick={handleGeocode} disabled={geocoding || !form.address}
                  style={{ background: geoResult ? "#10B981" : "#1e3a5f", color: geoResult ? "#060913" : "#60a5fa", border: "none", borderRadius: 6, padding: "8px 14px", fontFamily: fnt, fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {geocoding ? "⟳" : geoResult ? "✓ FOUND" : "GEOCODE →"}
                </button>
              </div>
              {geoResult && (
                <div style={{ fontSize: 9, color: "#10B981", marginTop: 5 }}>
                  ✓ {geoResult.formatted_address} · {geoResult.lat.toFixed(4)}, {geoResult.lng.toFixed(4)}
                </div>
              )}
            </div>

            <div>
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: ".08em", marginBottom: 5 }}>AI QUALIFIER SCORE (1–10)</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input type="range" min={1} max={10} value={form.score} onChange={(e) => setForm((p) => ({ ...p, score: +e.target.value }))} style={{ flex: 1 }} />
                <Badge score={+form.score} />
              </div>
            </div>

            {!geoResult && (
              <div style={{ background: "#0a0e1a", border: "1px solid #1e293b", borderRadius: 6, padding: "10px 12px", fontSize: 10, color: "#475569", lineHeight: 1.8 }}>
                💡 Type the address above and click <strong style={{ color: "#60a5fa" }}>GEOCODE →</strong> to auto-pin it on the map using Google Maps. No manual lat/lng needed.
              </div>
            )}

            <button onClick={handleAddLead}
              disabled={!form.name || !form.address}
              style={{ background: form.name && form.address ? "#F59E0B" : "#1e293b", color: form.name && form.address ? "#060913" : "#334155", border: "none", borderRadius: 6, padding: "10px 18px", fontFamily: fnt, fontSize: 12, fontWeight: 700, cursor: form.name && form.address ? "pointer" : "default", letterSpacing: ".08em" }}>
              + ADD TO MAP
            </button>
          </div>

          {/* Bland.ai info card */}
          <div style={{ marginTop: 20, background: "#060913", border: "1px solid #6366F133", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 10, color: "#818CF8", letterSpacing: ".1em", fontWeight: 700, marginBottom: 10 }}>🤖 BLAND.AI AUTO-FEED</div>
            <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.8 }}>
              Leads scoring 7+ from AI qualifier calls are <strong style={{ color: "#e2e8f0" }}>automatically added to this map</strong> within seconds of the call ending.
            </div>
            <div style={{ marginTop: 12, background: "#0a0e1a", border: "1px solid #1e293b", borderRadius: 6, padding: "10px 12px", fontSize: 10, color: "#334155", fontFamily: fnt }}>
              <div style={{ color: "#475569", marginBottom: 4 }}>YOUR WEBHOOK URL:</div>
              <div style={{ color: "#10B981", wordBreak: "break-all" }}>{API}/api/webhook/bland</div>
            </div>
            <div style={{ marginTop: 10, fontSize: 10, color: "#334155", lineHeight: 1.8 }}>
              In Bland.ai dashboard: Agent Settings → Webhook → paste URL above.<br />
              Map auto-refreshes every 15 seconds to show new AI leads.
            </div>
            {blandNew.length > 0 && (
              <div style={{ marginTop: 12, background: "#6366F111", border: "1px solid #6366F133", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "#818CF8", fontWeight: 700, marginBottom: 6 }}>{blandNew.length} NEW AI LEAD{blandNew.length > 1 ? "S" : ""} WAITING</div>
                {blandNew.map((l) => (
                  <div key={l.id} style={{ fontSize: 11, color: "#e2e8f0", marginBottom: 4 }}>
                    {l.name} <Badge score={l.score} /> — {l.address}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Toast message={toast.message} type={toast.type} />
    </div>
  );
}
