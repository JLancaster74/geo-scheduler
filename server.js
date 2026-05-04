require("dotenv").config();
const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────────────────────
// PIPELINE STAGES
// New → Qualified → Appointment Set → Presented → Follow Up → Sold
// ─────────────────────────────────────────────────────────────────────────────
const STAGES = ["new", "qualified", "appointment_set", "presented", "follow_up", "sold"];

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY STORE
// ─────────────────────────────────────────────────────────────────────────────
let leads = [
  { id:1, name:"Ruth Dawson",         phone:"+16625550944", address:"1150 Swinnea Rd, Southaven, MS",    lat:34.986, lng:-89.998, score:10, notes:"Premium tile, big budget, ASAP",        stage:"new", status:"new", createdAt: new Date().toISOString() },
  { id:2, name:"James & Carol Dunn",  phone:"+19015550391", address:"890 Poplar Pike, Collierville, TN", lat:35.055, lng:-89.671, score:10, notes:"Two bathrooms, strong budget",           stage:"new", status:"new", createdAt: new Date().toISOString() },
  { id:3, name:"Roy & Lois Pugh",     phone:"+19015551256", address:"940 Cordova Rd, Cordova, TN",      lat:35.149, lng:-89.782, score:9,  notes:"Full master suite reno",                stage:"new", status:"new", createdAt: new Date().toISOString() },
  { id:4, name:"Helen Kowalski",      phone:"+19015550734", address:"2210 Appling Rd, Bartlett, TN",    lat:35.195, lng:-89.885, score:9,  notes:"Referred by neighbor",                  stage:"new", status:"new", createdAt: new Date().toISOString() },
  { id:5, name:"Margaret & Ron Holt", phone:"+19015550142", address:"412 Bellevue Ct, Germantown, TN",  lat:35.092, lng:-89.814, score:9,  notes:"Master bath, safety bars, budget flex",  stage:"new", status:"new", createdAt: new Date().toISOString() },
];
let nextId = 6;

// Scheduled automation timers (in-memory queue)
const automationQueue = [];

// ─────────────────────────────────────────────────────────────────────────────
// TWILIO HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function sendSMS(to, body) {
  if (!to || !process.env.TWILIO_ACCOUNT_SID) return;
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
    console.log(`SMS sent to ${to}`);
  } catch (err) {
    console.error(`SMS failed to ${to}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDGRID EMAIL HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!to || !process.env.SENDGRID_API_KEY) return;
  try {
    await axios.post("https://api.sendgrid.com/v3/mail/send", {
      personalizations: [{ to: [{ email: to }], subject }],
      from: { email: process.env.FROM_EMAIL || "jonathan@jonathanlancasterremodeling.com", name: "Jonathan Lancaster Renovations" },
      content: [{ type: "text/html", value: html }],
    }, {
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Email failed to ${to}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFY JONATHAN — text + email alert
// ─────────────────────────────────────────────────────────────────────────────
async function notifyJonathan(subject, message) {
  // SMS alert
  await sendSMS(process.env.YOUR_PHONE_NUMBER, `🔔 ${subject}\n\n${message}`);
  // Email alert
  await sendEmail(
    process.env.YOUR_EMAIL || "jonthanlancaster@icloud.com",
    `🔔 ${subject}`,
    `<div style="font-family:Arial,sans-serif;padding:20px;max-width:600px">
      <h2 style="color:#C9A96E">${subject}</h2>
      <p style="font-size:15px;line-height:1.8;white-space:pre-line">${message}</p>
      <a href="https://jonathan-scheduler.netlify.app" style="background:#C9A96E;color:#1a1a2e;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;margin-top:16px">Open Dashboard →</a>
    </div>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATION ENGINE
// Runs every 60 seconds, checks for scheduled automations to fire
// ─────────────────────────────────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  const pending = automationQueue.filter(a => !a.fired && a.fireAt <= now);
  for (const automation of pending) {
    automation.fired = true;
    const lead = leads.find(l => l.id === automation.leadId);
    if (!lead) continue;
    console.log(`Firing automation: ${automation.type} for ${lead.name}`);
    await runAutomation(automation.type, lead);
  }
}, 60000);

async function runAutomation(type, lead) {
  const firstName = lead.name.split(/[\s&]/)[0];

  switch (type) {

    // ── SMS DRIP DAY 1 — after consultation ────────────────────────────────
    case "followup_day1":
      await sendSMS(lead.phone,
        `Hi ${firstName}! This is Jonathan Lancaster. I truly enjoyed meeting with you today about your bath renovation. I wanted to check in — do you have any questions I can answer? Reply anytime or call me at ${process.env.YOUR_PHONE_NUMBER}.`
      );
      await notifyJonathan(
        `Day 1 Follow-Up Sent — ${lead.name}`,
        `Automatic day 1 follow-up SMS was sent to ${lead.name} at ${lead.phone}.\n\nAddress: ${lead.address}\nScore: ${lead.score}/10\nNotes: ${lead.notes}`
      );
      break;

    // ── SMS DRIP DAY 3 ─────────────────────────────────────────────────────
    case "followup_day3":
      await sendSMS(lead.phone,
        `Hi ${firstName}, Jonathan Lancaster here again! I wanted to share that we have a special financing option available this month that could make your bathroom renovation very affordable. Would you like to hear more? Reply YES or call ${process.env.YOUR_PHONE_NUMBER}.`
      );
      await notifyJonathan(
        `Day 3 Follow-Up Sent — ${lead.name}`,
        `Automatic day 3 follow-up SMS sent to ${lead.name}.\n\nPhone: ${lead.phone}\nAddress: ${lead.address}`
      );
      break;

    // ── SMS DRIP DAY 7 ─────────────────────────────────────────────────────
    case "followup_day7":
      await sendSMS(lead.phone,
        `Hi ${firstName}! Jonathan Lancaster here. I know renovations are a big decision and I want to make sure you have everything you need to feel confident. I'd love to answer any questions — no pressure at all. Call me at ${process.env.YOUR_PHONE_NUMBER} or reply here anytime.`
      );
      await notifyJonathan(
        `Day 7 Follow-Up Sent — ${lead.name}`,
        `Automatic day 7 follow-up SMS sent to ${lead.name}.\n\nPhone: ${lead.phone}\nAddress: ${lead.address}\n\n⚠️ If no response after this, consider a personal call.`
      );
      break;

    // ── NO-SHOW RECOVERY — 30 min after missed appointment ────────────────
    case "noshow_recovery":
      await sendSMS(lead.phone,
        `Hi ${firstName}, this is Jonathan Lancaster. I stopped by today for our free consultation but may have missed you! I'd love to reschedule at your convenience — it only takes 60-90 minutes and is completely free. Call me at ${process.env.YOUR_PHONE_NUMBER} or reply to this text.`
      );
      await notifyJonathan(
        `No-Show Recovery Sent — ${lead.name}`,
        `${lead.name} missed their appointment. Recovery SMS has been sent.\n\nPhone: ${lead.phone}\nAddress: ${lead.address}\n\n📞 Consider calling them personally within the next hour.`
      );
      break;

    // ── REFERRAL REQUEST — after job sold ─────────────────────────────────
    case "referral_request":
      await sendSMS(lead.phone,
        `Hi ${firstName}! Jonathan Lancaster here. It was such a pleasure working with you on your bathroom renovation! If you love the results, I would be so grateful if you could share my name with friends or neighbors who might benefit. You can also leave us a Google review here: https://g.page/r/YOUR_GOOGLE_REVIEW_LINK\n\nThank you so much! — Jonathan`
      );
      await notifyJonathan(
        `Referral Request Sent — ${lead.name}`,
        `Referral request SMS sent to ${lead.name} at ${lead.phone}.\n\nAddress: ${lead.address}\n\n💰 This lead is now in your referral pipeline.`
      );
      break;

    // ── 30-DAY RE-ENGAGEMENT ───────────────────────────────────────────────
    case "reengage_30":
      await sendSMS(lead.phone,
        `Hi ${firstName}, Jonathan Lancaster here. I was thinking about our conversation and wanted to check in. Are you still considering updating your bathroom? We have some beautiful new options I think you'd love — and financing is still available. No pressure at all! Call ${process.env.YOUR_PHONE_NUMBER} anytime.`
      );
      await notifyJonathan(
        `30-Day Re-Engagement Sent — ${lead.name}`,
        `30-day re-engagement SMS sent to ${lead.name}.\n\nPhone: ${lead.phone}\nAddress: ${lead.address}\nOriginal Score: ${lead.score}/10`
      );
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE AUTOMATIONS for a lead based on stage change
// ─────────────────────────────────────────────────────────────────────────────
function scheduleAutomations(lead, newStage) {
  const now = Date.now();
  const MIN = 60000;
  const HOUR = 3600000;
  const DAY = 86400000;

  // When stage moves to Presented → schedule 3-part SMS drip
  if (newStage === "presented") {
    automationQueue.push({ leadId: lead.id, type: "followup_day1", fireAt: now + DAY,     fired: false });
    automationQueue.push({ leadId: lead.id, type: "followup_day3", fireAt: now + 3*DAY,   fired: false });
    automationQueue.push({ leadId: lead.id, type: "followup_day7", fireAt: now + 7*DAY,   fired: false });
    console.log(`Scheduled 3-part drip for ${lead.name}`);
  }

  // When stage moves to Appointment Set → schedule no-show recovery 90 min later
  if (newStage === "appointment_set") {
    automationQueue.push({ leadId: lead.id, type: "noshow_recovery", fireAt: now + 90*MIN, fired: false });
    console.log(`Scheduled no-show recovery for ${lead.name}`);
  }

  // When stage moves to Sold → schedule referral request 3 days later
  if (newStage === "sold") {
    automationQueue.push({ leadId: lead.id, type: "referral_request", fireAt: now + 3*DAY, fired: false });
    console.log(`Scheduled referral request for ${lead.name}`);
  }

  // When stage moves to Follow Up → schedule 30-day re-engagement
  if (newStage === "follow_up") {
    automationQueue.push({ leadId: lead.id, type: "reengage_30", fireAt: now + 30*DAY, fired: false });
    console.log(`Scheduled 30-day re-engagement for ${lead.name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GEOCODE HELPER
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// PARSE NETLIFY OR DIRECT JSON
// ─────────────────────────────────────────────────────────────────────────────
function parseIncomingLead(body) {
  if (body.data) {
    const d = body.data || {};
    const firstName = d["first-name"] || d["first_name"] || d.name || "";
    const lastName  = d["last-name"]  || d["last_name"]  || "";
    const fullName  = lastName ? `${firstName} ${lastName}`.trim() : firstName;
    const street    = d.street || d.address || "";
    const city      = d.city   || "";
    const state     = d.state  || "";
    const zip       = d.zip    || "";
    const address   = street ? [street, city, state, zip].filter(Boolean).join(", ") : city || "";
    const rawPhone  = (d.phone || d["phone-number"] || "").replace(/\D/g, "");
    const phone     = rawPhone.length >= 10 ? `+1${rawPhone.slice(-10)}` : "";
    let score = 7;
    if (d.budget && d.budget.includes("15,000")) score = 8;
    if (d.budget && (d.budget.includes("20,000") || d.budget.includes("25,000"))) score = 9;
    if (d.budget && (d.budget.includes("30,000") || d.budget.includes("40,000") || d.budget.includes("50,000"))) score = 10;
    const interest = d["primary-interest"] || d.interest || "";
    if (interest.toLowerCase().includes("safety")) score = Math.max(score, 8);
    if (interest.toLowerCase().includes("full")) score = Math.max(score, 9);
    const homeAge = d["home-age"] || d.home_age || "";
    if (homeAge.includes("50+") || homeAge.includes("40-50") || homeAge.includes("40–50")) score = Math.max(score, 8);
    const notesParts = [];
    if (interest)           notesParts.push(`Interest: ${interest}`);
    if (d.budget)           notesParts.push(`Budget: ${d.budget}`);
    if (homeAge)            notesParts.push(`Home age: ${homeAge}`);
    if (d["start-time"])    notesParts.push(`Timeline: ${d["start-time"]}`);
    if (d["project-details"]) notesParts.push(`Notes: ${d["project-details"]}`);
    if (d.notes)            notesParts.push(`Notes: ${d.notes}`);
    return { name: fullName || "New Lead", phone, address, score, notes: notesParts.join(" · ") || "", source: "website", email: d.email || "" };
  }
  return {
    name: body.name || "New Lead", phone: body.phone || "", address: body.address || "",
    score: body.score || 7, notes: body.notes || "", source: body.source || "manual",
    lat: body.lat || null, lng: body.lng || null,
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
    sent, failed: results.filter(r => r.status === "rejected").length,
    results: results.map((r, i) => ({ name: appointments[i].name, status: r.status === "fulfilled" ? "sent" : "failed", error: r.reason?.message ?? null })),
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
  const lead = leads.find(l => l.call_id === call_id);
  if (lead) {
    lead.score = score;
    lead.stage = "qualified";
    lead.notes += ` | AI Call: ${variables.summary || ""}. Partner: ${variables.partner_available}. Financing: ${variables.financing_interest}.`;
    await notifyJonathan(
      `New Qualified Lead — ${lead.name} scored ${score}/10`,
      `Name: ${lead.name}\nPhone: ${lead.phone}\nAddress: ${lead.address}\nScore: ${score}/10\nSummary: ${variables.summary || "N/A"}\nPartner available: ${variables.partner_available}\nFinancing interest: ${variables.financing_interest}`
    );
  }
  res.json({ received: true, action: "updated", score });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. FREE REPORT
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/report", async (req, res) => {
  const d = req.body.data || req.body;
  const name  = d.name  || d["your-name"] || "Friend";
  const email = d.email || "";
  const phone = (d.phone || "").replace(/\D/g, "");
  const formattedPhone = phone.length >= 10 ? `+1${phone.slice(-10)}` : "";
  if (!email) return res.status(400).json({ error: "email required" });
  if (process.env.SENDGRID_API_KEY) {
    await sendEmail(email, `Your Free Report: 10 Hidden Dangers in Bathroom Renovations`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
        <div style="background:#1a1a2e;padding:30px;text-align:center">
          <h1 style="color:#C9A96E;margin:0;font-size:24px">Jonathan Lancaster Renovations</h1>
          <p style="color:#aaa;margin:8px 0 0">Bath & Shower Specialists · Memphis/Southaven</p>
        </div>
        <div style="padding:32px 24px">
          <p style="font-size:16px">Hi ${name},</p>
          <p>Thank you for requesting our free report. Here are the <strong>10 Hidden Dangers in Bathroom Renovations</strong> every homeowner should know:</p>
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
            <p style="margin:0;font-size:15px"><strong>The best way to avoid all 10?</strong> Schedule a free in-home consultation with Jonathan — no pressure, no obligation.</p>
          </div>
          <p style="text-align:center;margin:32px 0">
            <a href="https://jonathanlancasterremodeling.netlify.app/#schedule" style="background:#C9A96E;color:#1a1a2e;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:16px">Schedule My Free Consultation →</a>
          </p>
          <p style="font-size:14px;color:#666">Questions? Call Jonathan directly at <strong>662-782-1777</strong></p>
        </div>
        <div style="background:#f5f5f5;padding:16px;text-align:center;font-size:12px;color:#999">
          Jonathan Lancaster Renovations · Memphis & Southaven Metro · 662-782-1777
        </div>
      </div>`
    );
  }
  await sendSMS(process.env.YOUR_PHONE_NUMBER, `📋 FREE REPORT REQUEST\nName: ${name}\nEmail: ${email}\nPhone: ${formattedPhone || "not provided"}`);
  res.json({ received: true, name, email });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAD MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// GET all leads
app.get("/api/leads", (req, res) => res.json(leads));

// GET pipeline summary
app.get("/api/pipeline", (req, res) => {
  const summary = {};
  STAGES.forEach(s => { summary[s] = leads.filter(l => l.stage === s); });
  res.json({
    stages: STAGES,
    pipeline: summary,
    totals: Object.fromEntries(STAGES.map(s => [s, summary[s].length])),
    revenue: {
      sold: leads.filter(l => l.stage === "sold").length * 1900,
      potential: leads.filter(l => !["sold"].includes(l.stage)).length * 1900 * 0.4,
    },
  });
});

// POST new lead
app.post("/api/leads", async (req, res) => {
  console.log("Incoming lead payload:", JSON.stringify(req.body).slice(0, 300));
  const parsed = parseIncomingLead(req.body);
  if (!parsed.name && !parsed.address) return res.status(400).json({ error: "Could not parse lead data" });
  const lead = {
    id: nextId++,
    name: parsed.name, phone: parsed.phone, address: parsed.address,
    score: parsed.score, notes: parsed.notes, status: "new", stage: "new",
    source: parsed.source, email: parsed.email || "",
    lat: parsed.lat ?? null, lng: parsed.lng ?? null,
    createdAt: new Date().toISOString(),
    stageHistory: [{ stage: "new", at: new Date().toISOString() }],
  };
  if (!lead.lat || !lead.lng) await geocodeAndUpdate(lead);
  leads.push(lead);
  console.log(`New lead added: ${lead.name} | Score: ${lead.score} | Source: ${lead.source}`);

  // Notify Jonathan of new lead
  await notifyJonathan(
    `New Lead — ${lead.name}`,
    `Name: ${lead.name}\nPhone: ${lead.phone}\nAddress: ${lead.address}\nScore: ${lead.score}/10\nNotes: ${lead.notes}`
  );

  // Trigger Bland.ai call
  if (lead.phone && process.env.BLAND_API_KEY) {
    axios.post("https://api.bland.ai/v1/calls", {
      phone_number: lead.phone,
      task: `You are Christie, a warm and friendly scheduling assistant for Jonathan Lancaster Renovations in Memphis and Southaven. You are calling ${lead.name} who just requested a free bathroom consultation online. Their address is ${lead.address}. Have a natural warm conversation covering these topics: confirm they own their home (if not end politely), ask if they want to update their shower or bath area, ask about any safety concerns like slipping or difficulty getting in and out of the tub, ask if they prefer to self-fund or want to hear about financing options, ask if their spouse or partner can join the consultation, let them know the consultation is free and takes 60 to 90 minutes with no obligation and ask if they are open to it, confirm their address, then close with: Jonathan will call you personally within 24 hours to confirm. Have a wonderful day!`,
      voice: "d733d3e9-b2b4-4f46-a678-3fc878293c33",
      wait_for_greeting: false,
      record: true,
      answered_by_enabled: true,
      noise_cancellation: true,
      interruption_threshold: 500,
      block_interruptions: false,
      max_duration: 12,
      model: "base",
      language: "babel-en",
      background_track: "none",
      from: process.env.BLAND_PHONE_NUMBER || undefined,
      webhook: `${process.env.SERVER_URL}/api/webhook/bland`,
      request_data: { contact_name: lead.name, street_address: lead.address },
    }, {
      headers: { Authorization: process.env.BLAND_API_KEY, "Content-Type": "application/json" },
    }).then(r => {
      lead.call_id = r.data?.call_id;
      console.log(`Bland.ai call triggered for ${lead.name} — call_id: ${r.data?.call_id}`);
    }).catch(err => {
      console.error(`Bland.ai call failed for ${lead.name}:`, JSON.stringify(err.response?.data) || err.message);
    });
  }

  res.status(201).json(lead);
});

// PATCH lead — update stage or any field
app.patch("/api/leads/:id", async (req, res) => {
  const lead = leads.find(l => l.id === +req.params.id);
  if (!lead) return res.status(404).json({ error: "not found" });
  const oldStage = lead.stage;
  Object.assign(lead, req.body);

  // If stage changed — schedule automations and notify
  if (req.body.stage && req.body.stage !== oldStage) {
    if (!lead.stageHistory) lead.stageHistory = [];
    lead.stageHistory.push({ stage: req.body.stage, at: new Date().toISOString() });
    scheduleAutomations(lead, req.body.stage);

    const stageLabels = {
      qualified: "Qualified ✅",
      appointment_set: "Appointment Set 📅",
      presented: "Presented 🏠",
      follow_up: "Follow Up 🔄",
      sold: "SOLD 💰",
    };

    await notifyJonathan(
      `Lead Stage Update — ${lead.name} → ${stageLabels[req.body.stage] || req.body.stage}`,
      `Name: ${lead.name}\nPhone: ${lead.phone}\nAddress: ${lead.address}\nNew Stage: ${req.body.stage}\nScore: ${lead.score}/10`
    );
  }

  res.json(lead);
});

// DELETE lead
app.delete("/api/leads/:id", (req, res) => {
  const idx = leads.findIndex(l => l.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  leads.splice(idx, 1);
  res.json({ deleted: true });
});

// Manual automation trigger (for testing)
app.post("/api/automations/trigger", async (req, res) => {
  const { leadId, type } = req.body;
  const lead = leads.find(l => l.id === +leadId);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  await runAutomation(type, lead);
  res.json({ triggered: true, type, lead: lead.name });
});

// GET automation queue status
app.get("/api/automations", (req, res) => {
  res.json(automationQueue.map(a => ({
    ...a,
    lead: leads.find(l => l.id === a.leadId)?.name,
    firesIn: Math.round((a.fireAt - Date.now()) / 60000) + " minutes",
  })));
});

// Debug endpoint
app.post("/api/debug", (req, res) => {
  console.log("RAW BODY:", JSON.stringify(req.body, null, 2));
  res.json({ received: req.body });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    leads: leads.length,
    pipeline: Object.fromEntries(STAGES.map(s => [s, leads.filter(l => l.stage === s).length])),
    automations_pending: automationQueue.filter(a => !a.fired).length,
    env: {
      google_maps:  !!process.env.GOOGLE_MAPS_API_KEY,
      twilio:       !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      twilio_phone: !!process.env.TWILIO_PHONE_NUMBER,
      sendgrid:     !!process.env.SENDGRID_API_KEY,
      bland:        !!process.env.BLAND_API_KEY,
    },
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GeoScheduler + CRM running on port ${PORT}`);
  console.log(`Google Maps: ${process.env.GOOGLE_MAPS_API_KEY ? "connected" : "MISSING"}`);
  console.log(`Twilio: ${process.env.TWILIO_ACCOUNT_SID ? "connected" : "MISSING"}`);
  console.log(`SendGrid: ${process.env.SENDGRID_API_KEY ? "connected" : "MISSING"}`);
  console.log(`Bland.ai: ${process.env.BLAND_API_KEY ? "connected" : "MISSING"}`);
});
