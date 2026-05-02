require("dotenv").config();
const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // needed for Netlify form posts

// ── In-memory lead store ──────────────────────────────────────────────────────
let leads = [
  { id:1, name:"Ruth Dawson",         phone:"+16625550944", address:"1150 Swinnea Rd, Southaven, MS",    lat:34.986, lng:-89.998, score:10, notes:"Premium tile, big budget, ASAP",       status:"new" },
  { id:2, name:"James & Carol Dunn",  phone:"+19015550391", address:"890 Poplar Pike, Collierville, TN", lat:35.055, lng:-89.671, score:10, notes:"Two bathrooms, strong budget",          status:"new" },
  { id:3, name:"Roy & Lois Pugh",     phone:"+19015551256", address:"940 Cordova Rd, Cordova, TN",      lat:35.149, lng:-89.782, score:9,  notes:"Full master suite reno",               status:"new" },
  { id:4, name:"Helen Kowalski",      phone:"+19015550734", address:"2210 Appling Rd, Bartlett, TN",    lat:35.195, lng:-89.885, score:9,  notes:"Referred by neighbor",                 status:"new" },
  { id:5, name:"Margaret & Ron Holt", phone:"+19015550142", address:"412 Bellevue Ct, Germantown, TN",  lat:35.092, lng:-89.814, score:9,  notes:"Master bath, safety bars, budget flex", status:"new" },
];
let nextId = 6;

// ── Geocode helper ────────────────────────────────────────────────────────────
async function geocodeAndUpdate(lead) {
  if (!lead.address) return;
  try {
    const r = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: lead.address, key: process.env.GOOGLE_MAPS_API_KEY },
    });
    const loc = r.data.results?.[0]?.geometry?.location;
    if (loc) { lead.lat = loc.lat; lead.lng = loc.lng; }
    console.log(`Geocoded "${lead.name}": ${lead.lat}, ${lead.lng}`);
  } catch (err) {
    console.error(`Geocode failed for "${lead.name}":`, err.message);
  }
}

// ── Parse Netlify webhook OR direct JSON into a standard lead object ──────────
// Netlify sends: { payload: { data: { first_name, last_name, phone, ... } } }
// Dashboard sends: { name, phone, address, score, notes }
function parseIncomingLead(body) {
  // ── Netlify format ──
  // Netlify sends form fields inside body.data (not body.payload)
  if (body.data) {
    const d = body.data || {};
    const formName = body.form_name || body.title || "";

    // Build full name from first + last if present
    const firstName = d["first-name"] || d["first_name"] || d.name || "";
    const lastName  = d["last-name"]  || d["last_name"]  || "";
    const fullName  = lastName ? `${firstName} ${lastName}`.trim() : firstName;

    // Build full address from individual fields
    const street = d.street || d.address || "";
    const city   = d.city   || "";
    const state  = d.state  || "";
    const zip    = d.zip    || "";
    const address = street
      ? [street, city, state, zip].filter(Boolean).join(", ")
      : city || "";

    // Phone — strip ALL non-digits then take last 10, prefix +1
    const rawPhone = (d.phone || d["phone-number"] || "").replace(/\D/g, "");
    const phone = rawPhone.length >= 10 ? `+1${rawPhone.slice(-10)}` : "";

    // Score based on form fields
    // Contact form uses: primary-interest, budget, home-age, start-time, project-details
    // Booking form uses: name, phone, address, preferred-date, preferred-time, notes
    let score = 7;
    if (d.budget && d.budget.includes("15,000")) score = 8;
    if (d.budget && (d.budget.includes("20,000") || d.budget.includes("25,000"))) score = 9;
    if (d.budget && (d.budget.includes("30,000") || d.budget.includes("40,000") || d.budget.includes("50,000"))) score = 10;
    const interest = d["primary-interest"] || d.interest || "";
    if (interest.toLowerCase().includes("safety")) score = Math.max(score, 8);
    if (interest.toLowerCase().includes("full")) score = Math.max(score, 9);
    const homeAge = d["home-age"] || d.home_age || "";
    if (homeAge.includes("50+") || homeAge.includes("40-50") || homeAge.includes("40–50")) score = Math.max(score, 8);

    // Build notes from all available fields
    const notesParts = [];
    if (interest)                    notesParts.push(`Interest: ${interest}`);
    if (d.budget)                    notesParts.push(`Budget: ${d.budget}`);
    if (homeAge)                     notesParts.push(`Home age: ${homeAge}`);
    if (d["start-time"])             notesParts.push(`Timeline: ${d["start-time"]}`);
    if (d["project-details"])        notesParts.push(`Notes: ${d["project-details"]}`);
    if (d.notes)                     notesParts.push(`Notes: ${d.notes}`);
    if (d["preferred-date"])         notesParts.push(`Requested date: ${d["preferred-date"]}`);
    if (d["preferred-time"])         notesParts.push(`Requested time: ${d["preferred-time"]}`);

    return {
      name:    fullName  || "New Lead",
      phone:   phone     || "",
      address: address   || "",
      score,
      notes:   notesParts.join(" · ") || `Form: ${formName}`,
      source:  "website",
      email:   d.email   || "",
    };
  }

  // ── Direct JSON format (from dashboard Add Lead form) ──
  return {
    name:    body.name    || "New Lead",
    phone:   body.phone   || "",
    address: body.address || "",
    score:   body.score   || 7,
    notes:   body.notes   || "",
    source:  body.source  || "manual",
    lat:     body.lat     || null,
    lng:     body.lng     || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GOOGLE GEOCODING
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/geocode", async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address is required" });
  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json",
      { params: { address, key: process.env.GOOGLE_MAPS_API_KEY } }
    );
    const result = response.data.results?.[0];
    if (!result) return res.status(404).json({ error: "Address not found" });
    const { lat, lng } = result.geometry.location;
    res.json({ lat, lng, formatted_address: result.formatted_address });
  } catch (err) {
    res.status(500).json({ error: "Geocoding failed", detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TWILIO SMS CONFIRMATIONS
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/sms/confirm", async (req, res) => {
  const { appointments } = req.body;
  if (!appointments?.length) return res.status(400).json({ error: "appointments array is required" });

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  const results = await Promise.allSettled(
    appointments.map(async (apt) => {
      const firstName = apt.name.split(/[\s&]/)[0];
      const body =
        `Hi ${firstName}! Your FREE bath/shower consultation is confirmed:\n` +
        `Date: ${apt.date} at ${apt.time}\n` +
        `Address: ${apt.address}\n\n` +
        `Reply YES to confirm or call ${process.env.YOUR_PHONE_NUMBER} to reschedule.`;
      return client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to: apt.phone });
    })
  );

  const sent = results.filter(r => r.status === "fulfilled").length;
  res.json({
    sent,
    failed: results.filter(r => r.status === "rejected").length,
    results: results.map((r, i) => ({
      name: appointments[i].name,
      status: r.status === "fulfilled" ? "sent" : "failed",
      error: r.reason?.message ?? null,
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BLAND.AI WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/webhook/bland", async (req, res) => {
  const { call_id, status, variables = {} } = req.body;
  console.log(`Bland.ai call — ID: ${call_id} | Status: ${status}`);

  if (status !== "completed") return res.json({ received: true, action: "ignored" });

  const score = parseInt(variables.lead_score ?? "0", 10);
  if (score < 7) return res.json({ received: true, action: "filtered", score });

  const lead = {
    id: nextId++,
    name:    variables.contact_name   || "Unknown",
    phone:   variables.phone_number   || "",
    address: variables.street_address || "",
    score,
    notes:   variables.summary || `Owns: ${variables.owns_home}. Safety: ${variables.safety_concern}. Partner available: ${variables.partner_available}. Financing interest: ${variables.financing_interest}.`,
    status:  "new",
    source:  "bland_ai",
    call_id,
    lat: null,
    lng: null,
  };

  leads.push(lead);
  geocodeAndUpdate(lead);
  res.json({ received: true, action: "added", lead_id: lead.id, score });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAD MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/leads", (req, res) => res.json(leads));

// Main POST — handles both Netlify webhooks AND dashboard form
app.post("/api/leads", async (req, res) => {
  console.log("Incoming lead payload:", JSON.stringify(req.body).slice(0, 300));

  const parsed = parseIncomingLead(req.body);

  if (!parsed.name && !parsed.address) {
    return res.status(400).json({ error: "Could not parse lead data" });
  }

  const lead = {
    id:      nextId++,
    name:    parsed.name,
    phone:   parsed.phone,
    address: parsed.address,
    score:   parsed.score,
    notes:   parsed.notes,
    status:  "new",
    source:  parsed.source,
    email:   parsed.email || "",
    lat:     parsed.lat ?? null,
    lng:     parsed.lng ?? null,
  };

  // Geocode if no coordinates yet
  if (!lead.lat || !lead.lng) await geocodeAndUpdate(lead);

  leads.push(lead);
  console.log(`New lead added: ${lead.name} | Score: ${lead.score} | Source: ${lead.source}`);

  // ── Auto-call via Bland.ai within 90 seconds ────────────────────────────────
  if (lead.phone && process.env.BLAND_API_KEY) {
    axios.post("https://api.bland.ai/v1/calls", {
      phone_number: lead.phone,
      task: `You are Christie, a warm and friendly scheduling assistant for Jonathan Lancaster Renovations in Memphis and Southaven. You are calling ${lead.name} who just requested a free bathroom consultation online. Their address is ${lead.address}. Have a natural warm conversation covering these topics: confirm they own their home (if not end politely), ask if they want to update their shower or bath area, ask about any safety concerns like slipping or difficulty getting in and out, ask if they prefer to self-fund or want to hear about financing options, ask if their spouse or partner can join the consultation, let them know the consultation is free and takes 60 to 90 minutes with no obligation and ask if they are open to it, confirm their address, then close with: Jonathan will call you personally within 24 hours to confirm. Have a wonderful day!`,
      voice: "christie",
      wait_for_greeting: true,
      record: true,
      max_duration: 10,
      from: process.env.BLAND_PHONE_NUMBER || undefined,
      webhook: `${process.env.SERVER_URL}/api/webhook/bland`,
      background_track: "none",
      model: "enhanced",
      request_data: {
        contact_name: lead.name,
        street_address: lead.address,
      },
    }, {
      wait_for_greeting: true,
      record: true,
      max_duration: 10,
      from: process.env.BLAND_PHONE_NUMBER || undefined,
      webhook: `${process.env.SERVER_URL}/api/webhook/bland`,
      background_track: "none",
      request_data: {
        contact_name: lead.name,
        street_address: lead.address,
      },
      model: "enhanced",
      language: "en-US",
    }, {
      headers: { authorization: process.env.BLAND_API_KEY },
    }).then(r => {
      console.log(`Bland.ai call triggered for ${lead.name} — call_id: ${r.data?.call_id}`);
    }).catch(err => {
      console.error(`Bland.ai call failed for ${lead.name}:`, JSON.stringify(err.response?.data) || err.message);
    });
  }

  res.status(201).json(lead);
});

app.patch("/api/leads/:id", (req, res) => {
  const lead = leads.find(l => l.id === +req.params.id);
  if (!lead) return res.status(404).json({ error: "not found" });
  Object.assign(lead, req.body);
  res.json(lead);
});

app.delete("/api/leads/:id", (req, res) => {
  const idx = leads.findIndex(l => l.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  leads.splice(idx, 1);
  res.json({ deleted: true });
});

// ── Free Report email ─────────────────────────────────────────────────────────
app.post("/api/report", async (req, res) => {
  console.log("Report request:", JSON.stringify(req.body).slice(0, 200));

  const d = req.body.data || req.body;
  const name  = d.name  || d["your-name"] || "Friend";
  const email = d.email || "";
  const phone = (d.phone || "").replace(/\D/g, "");
  const formattedPhone = phone.length >= 10 ? `+1${phone.slice(-10)}` : "";

  if (!email) return res.status(400).json({ error: "email required" });

  // ── Send report email via SendGrid ──────────────────────────────────────────
  if (process.env.SENDGRID_API_KEY) {
    try {
      await axios.post("https://api.sendgrid.com/v3/mail/send", {
        personalizations: [{
          to: [{ email, name }],
          subject: `Your Free Report: 10 Hidden Dangers in Bathroom Renovations`,
        }],
        from: {
          email: process.env.FROM_EMAIL || "jonathan@jonathanlancasterremodeling.com",
          name: "Jonathan Lancaster Renovations",
        },
        content: [{
          type: "text/html",
          value: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
              <div style="background:#1a1a2e;padding:30px;text-align:center">
                <h1 style="color:#C9A96E;margin:0;font-size:24px">Jonathan Lancaster Renovations</h1>
                <p style="color:#aaa;margin:8px 0 0">Bath & Shower Specialists · Memphis/Southaven</p>
              </div>
              <div style="padding:32px 24px">
                <p style="font-size:16px">Hi ${name},</p>
                <p>Thank you for requesting our free report. Here are the <strong>10 Hidden Dangers in Bathroom Renovations</strong> that every homeowner should know before hiring a contractor:</p>
                <ol style="line-height:2;font-size:15px">
                  <li><strong>Unlicensed contractors</strong> — always verify licensing with your state board</li>
                  <li><strong>No permit pulled</strong> — unpermitted work can void your homeowner's insurance</li>
                  <li><strong>Cheap waterproofing</strong> — leads to mold and structural damage within 2 years</li>
                  <li><strong>Wrong tile adhesive</strong> — tiles crack and pop off within months</li>
                  <li><strong>No slip resistance testing</strong> — wet floors are the #1 cause of bathroom falls</li>
                  <li><strong>Ignoring grab bar blocking</strong> — walls need reinforcement to hold grab bars safely</li>
                  <li><strong>Undersized water heater</strong> — walk-in showers need more hot water capacity</li>
                  <li><strong>Poor ventilation planning</strong> — inadequate fans cause mold within 6 months</li>
                  <li><strong>No written warranty</strong> — reputable contractors always provide written coverage</li>
                  <li><strong>Skipping the consultation</strong> — rushing into a decision without seeing all options costs thousands</li>
                </ol>
                <div style="background:#f9f5ef;border-left:4px solid #C9A96E;padding:20px;margin:24px 0;border-radius:4px">
                  <p style="margin:0;font-size:15px"><strong>The best way to avoid all 10?</strong> Schedule a free in-home consultation with Jonathan. He'll walk through your bathroom, identify any concerns, and show you exactly what's possible — with no pressure and no obligation.</p>
                </div>
                <p style="text-align:center;margin:32px 0">
                  <a href="https://jonathanlancasterremodeling.netlify.app/#schedule" 
                     style="background:#C9A96E;color:#1a1a2e;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:16px">
                    Schedule My Free Consultation →
                  </a>
                </p>
                <p style="font-size:14px;color:#666">Questions? Call Jonathan directly at <strong>662-782-1777</strong> or simply reply to this email.</p>
              </div>
              <div style="background:#f5f5f5;padding:16px;text-align:center;font-size:12px;color:#999">
                Jonathan Lancaster Renovations · Serving Memphis & Southaven Metro<br>
                662-782-1777 · jonathanlancasterremodeling.netlify.app
              </div>
            </div>
          `,
        }],
      }, {
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
      });
      console.log(`Report email sent to ${email}`);
    } catch (err) {
      console.error("SendGrid email failed:", err.response?.data || err.message);
    }
  }

  // Always SMS Jonathan so he knows someone requested the report
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      body: `📋 FREE REPORT REQUEST\nName: ${name}\nEmail: ${email}\nPhone: ${formattedPhone || "not provided"}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.YOUR_PHONE_NUMBER,
    });
  } catch (err) {
    console.error("Report SMS failed:", err.message);
  }

  res.json({ received: true, name, email });
});


app.post("/api/debug", (req, res) => {
  console.log("RAW BODY:", JSON.stringify(req.body, null, 2));
  res.json({ received: req.body });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    leads: leads.length,
    env: {
      google_maps:  !!process.env.GOOGLE_MAPS_API_KEY,
      twilio:       !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      twilio_phone: !!process.env.TWILIO_PHONE_NUMBER,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GeoScheduler running on port ${PORT}`);
  console.log(`Google Maps: ${process.env.GOOGLE_MAPS_API_KEY ? "connected" : "MISSING"}`);
  console.log(`Twilio: ${process.env.TWILIO_ACCOUNT_SID ? "connected" : "MISSING"}`);
});
