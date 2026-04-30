// ─────────────────────────────────────────────────────────────────────────────
// GeoScheduler Backend — server.js
// Integrations: Google Geocoding · Twilio SMS · Bland.ai Webhook
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ── In-memory lead store ─────────────────────────────────────────────────────
// In production: swap this array for a database (Postgres, Supabase, etc.)
let leads = [
  { id: 1,  name: "Ruth Dawson",       phone: "+16625550944", address: "1150 Swinnea Rd, Southaven, MS",       lat: 34.986, lng: -89.998, score: 10, notes: "Premium tile, big budget, ASAP",       status: "new" },
  { id: 2,  name: "James & Carol Dunn",phone: "+19015550391", address: "890 Poplar Pike, Collierville, TN",    lat: 35.055, lng: -89.671, score: 10, notes: "Two bathrooms, strong budget",          status: "new" },
  { id: 3,  name: "Roy & Lois Pugh",   phone: "+19015551256", address: "940 Cordova Rd, Cordova, TN",         lat: 35.149, lng: -89.782, score: 9,  notes: "Full master suite reno",               status: "new" },
  { id: 4,  name: "Helen Kowalski",    phone: "+19015550734", address: "2210 Appling Rd, Bartlett, TN",       lat: 35.195, lng: -89.885, score: 9,  notes: "Referred by neighbor",                 status: "new" },
  { id: 5,  name: "Margaret & Ron Holt",phone:"+19015550142", address: "412 Bellevue Ct, Germantown, TN",     lat: 35.092, lng: -89.814, score: 9,  notes: "Master bath, safety bars, budget flex", status: "new" },
];
let nextId = 6;

// ── Helper: async geocode a lead and update in place ────────────────────────
async function geocodeAndUpdate(lead) {
  try {
    const r = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: lead.address, key: process.env.GOOGLE_MAPS_API_KEY },
    });
    const loc = r.data.results?.[0]?.geometry?.location;
    if (loc) {
      lead.lat = loc.lat;
      lead.lng = loc.lng;
      console.log(`✓ Geocoded "${lead.name}": ${loc.lat}, ${loc.lng}`);
    }
  } catch (err) {
    console.error(`✗ Geocode failed for "${lead.name}":`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GOOGLE GEOCODING
//    POST /api/geocode
//    Body: { address: "412 Bellevue Ct, Germantown, TN" }
//    Returns: { lat, lng, formatted_address }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/geocode", async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address is required" });

  try {
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      { params: { address, key: process.env.GOOGLE_MAPS_API_KEY } }
    );

    const result = response.data.results?.[0];
    if (!result) return res.status(404).json({ error: "Address not found" });

    const { lat, lng } = result.geometry.location;
    res.json({ lat, lng, formatted_address: result.formatted_address });
  } catch (err) {
    console.error("Geocode error:", err.message);
    res.status(500).json({ error: "Geocoding failed", detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TWILIO SMS CONFIRMATIONS
//    POST /api/sms/confirm
//    Body: { appointments: [{ name, phone, time, date, address }] }
//    Returns: { sent, failed, results }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/sms/confirm", async (req, res) => {
  const { appointments } = req.body;
  if (!appointments?.length) {
    return res.status(400).json({ error: "appointments array is required" });
  }

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  const results = await Promise.allSettled(
    appointments.map(async (apt) => {
      const firstName = apt.name.split(/[\s&]/)[0];
      const body =
        `Hi ${firstName}! ✅ Your FREE bath/shower consultation is confirmed:\n` +
        `📅 ${apt.date} at ${apt.time}\n` +
        `📍 ${apt.address}\n\n` +
        `Reply YES to confirm or call ${process.env.YOUR_PHONE_NUMBER} to reschedule. ` +
        `We look forward to meeting you!`;

      return client.messages.create({
        body,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: apt.phone,
      });
    })
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected");

  console.log(`SMS: ${sent} sent, ${failed.length} failed`);

  res.json({
    sent,
    failed: failed.length,
    results: results.map((r, i) => ({
      name: appointments[i].name,
      phone: appointments[i].phone,
      status: r.status === "fulfilled" ? "sent" : "failed",
      sid: r.value?.sid ?? null,
      error: r.reason?.message ?? null,
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BLAND.AI WEBHOOK
//    POST /api/webhook/bland
//    Called automatically by Bland.ai after each AI qualifier call ends.
//    Bland sends the transcript + extracted variables you defined in your agent.
//    Leads scoring 7+ are auto-added to the scheduler.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/webhook/bland", async (req, res) => {
  // Bland.ai payload shape (simplified — log req.body once to see full shape)
  const {
    call_id,
    call_length,        // seconds
    status,             // "completed" | "voicemail" | "no-answer"
    variables = {},     // extracted by your Bland agent
    transcript,
  } = req.body;

  console.log(`\n📞 Bland.ai call received — ID: ${call_id} | Status: ${status}`);

  // Only process completed calls
  if (status !== "completed") {
    return res.json({ received: true, action: "ignored", reason: status });
  }

  // Variables your Bland.ai agent should extract (configure in Bland dashboard):
  // {{lead_score}}       — numeric 1-10 qualification score
  // {{contact_name}}     — full name
  // {{phone_number}}     — their phone
  // {{street_address}}   — full address
  // {{owns_home}}        — "yes" / "no"
  // {{safety_concern}}   — "yes" / "no"
  // {{budget_ok}}        — "yes" / "no"
  // {{summary}}          — 1-sentence summary of call

  const score = parseInt(variables.lead_score ?? "0", 10);
  const name = variables.contact_name ?? "Unknown";
  const phone = variables.phone_number ?? "";
  const address = variables.street_address ?? "";

  console.log(`   Name: ${name} | Score: ${score}/10 | Address: ${address}`);

  if (score < 7) {
    console.log(`   → Score ${score} below threshold. Not added.`);
    return res.json({ received: true, action: "filtered", score });
  }

  // Build the new lead
  const lead = {
    id: nextId++,
    name,
    phone,
    address,
    score,
    notes: variables.summary ?? `Called ${Math.round(call_length / 60)}min. Owns: ${variables.owns_home}. Safety concern: ${variables.safety_concern}. Budget OK: ${variables.budget_ok}.`,
    status: "new",
    source: "bland_ai",
    call_id,
    lat: null,
    lng: null,
  };

  leads.push(lead);
  console.log(`   ✓ Added to scheduler (ID: ${lead.id})`);

  // Geocode async so webhook responds fast
  geocodeAndUpdate(lead).then(() => {
    console.log(`   ✓ Lead ${lead.id} geocoded`);
  });

  res.json({ received: true, action: "added", lead_id: lead.id, score });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAD MANAGEMENT — REST endpoints for the frontend
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/leads — return all leads
app.get("/api/leads", (req, res) => {
  res.json(leads);
});

// POST /api/leads — manually add a lead (frontend "Add Lead" form)
app.post("/api/leads", async (req, res) => {
  const { name, phone, address, score, notes, lat, lng } = req.body;
  if (!name || !address) {
    return res.status(400).json({ error: "name and address are required" });
  }
  const lead = {
    id: nextId++,
    name,
    phone: phone ?? "",
    address,
    score: score ?? 7,
    notes: notes ?? "",
    status: "new",
    source: "manual",
    lat: lat ?? null,
    lng: lng ?? null,
  };
  // If no lat/lng supplied, geocode now
  if (!lat || !lng) await geocodeAndUpdate(lead);
  leads.push(lead);
  res.status(201).json(lead);
});

// PATCH /api/leads/:id — update status
app.patch("/api/leads/:id", (req, res) => {
  const lead = leads.find((l) => l.id === +req.params.id);
  if (!lead) return res.status(404).json({ error: "not found" });
  Object.assign(lead, req.body);
  res.json(lead);
});

// DELETE /api/leads/:id
app.delete("/api/leads/:id", (req, res) => {
  const idx = leads.findIndex((l) => l.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  leads.splice(idx, 1);
  res.json({ deleted: true });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    leads: leads.length,
    env: {
      google_maps: !!process.env.GOOGLE_MAPS_API_KEY,
      twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      twilio_phone: !!process.env.TWILIO_PHONE_NUMBER,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 GeoScheduler API running on http://localhost:${PORT}`);
  console.log(`   Leads loaded: ${leads.length}`);
  console.log(`   Google Maps: ${process.env.GOOGLE_MAPS_API_KEY ? "✓" : "✗ MISSING"}`);
  console.log(`   Twilio:       ${process.env.TWILIO_ACCOUNT_SID ? "✓" : "✗ MISSING"}`);
  console.log(`\n   Bland.ai webhook URL: http://YOUR_SERVER:${PORT}/api/webhook/bland\n`);
});
