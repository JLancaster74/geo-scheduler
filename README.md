# GeoScheduler — Full Setup Guide

Bath & shower renovation appointment scheduler with:
- **Google Geocoding** — type any address, get lat/lng automatically
- **Twilio SMS** — sends appointment confirmations to leads
- **Bland.ai webhook** — AI qualifier calls auto-drop leads into the map (score 7+)

---

## 1. Prerequisites

- Node.js 18+ (https://nodejs.org)
- A Google Cloud account (free tier works)
- A Twilio account ($20 to get started)
- A Bland.ai account (pay-per-minute)

---

## 2. Backend setup

```bash
# Clone / unzip the project, then:
cd scheduler-backend
npm install
cp .env.example .env
```

Open `.env` and fill in your keys (see sections below), then:

```bash
npm run dev     # development (auto-restarts on changes)
# or
npm start       # production
```

Server starts at http://localhost:3001
Test it: http://localhost:3001/api/health

---

## 3. Google Maps API key (for geocoding)

1. Go to https://console.cloud.google.com
2. Create a new project (or use existing)
3. Search "Geocoding API" → Enable it
4. Go to Credentials → Create API Key
5. Restrict the key to "Geocoding API" only (security best practice)
6. Copy the key into `.env`:
   ```
   GOOGLE_MAPS_API_KEY=AIzaSy...
   ```

**Cost:** ~$0.005 per address lookup. 200 addresses/month = $1.

---

## 4. Twilio SMS setup

1. Sign up at https://www.twilio.com (get $15 free trial credit)
2. Go to Console → Account Info
3. Copy Account SID and Auth Token into `.env`
4. Buy a phone number: Console → Phone Numbers → Buy a Number
   - Make sure it has SMS capability
   - Cost: ~$1/month
5. Copy the number into `.env` (format: +15551234567):
   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxx
   TWILIO_AUTH_TOKEN=your_token
   TWILIO_PHONE_NUMBER=+15551234567
   YOUR_PHONE_NUMBER=+19015550000   ← your personal number for callbacks
   ```

**Cost:** ~$0.0079 per SMS sent. 100 confirmations/month = $0.79.

> **Trial account limitation:** During Twilio trial, you can only SMS verified numbers.
> Upgrade to a paid account to SMS any number (~$20 one-time upgrade).

---

## 5. Bland.ai webhook setup

1. Create your AI qualifier agent at https://app.bland.ai
2. In your agent script, instruct it to extract these variables:
   ```
   {{lead_score}}      — numeric 1-10 score based on your criteria
   {{contact_name}}    — full name
   {{phone_number}}    — their phone number
   {{street_address}}  — full home address
   {{owns_home}}       — yes / no
   {{safety_concern}}  — yes / no  
   {{budget_ok}}       — yes / no (comfortable with $5-15k investment)
   {{summary}}         — one sentence summary of the call
   ```

3. In Bland.ai Agent Settings → Webhooks → add your server URL:
   ```
   http://YOUR_SERVER_IP:3001/api/webhook/bland
   ```

4. If running locally, use ngrok to expose your server:
   ```bash
   npx ngrok http 3001
   # Copy the https://xxxx.ngrok.io URL into Bland.ai
   ```

5. When a call ends with lead_score >= 7, the lead auto-appears in the scheduler map within 15 seconds.

---

## 6. Bland.ai qualifier script template

Paste this into your Bland.ai agent:

```
You are a friendly appointment scheduler for [YOUR COMPANY NAME], a bathroom renovation specialist.
Your job is to qualify homeowners for a free in-home consultation.

Ask these questions naturally in conversation:
1. "Do you own your home?" → If no, end politely.
2. "Are you experiencing any safety concerns in your bathroom — like slipping or difficulty getting in and out?" 
3. "Are you happy with how your bathroom looks, or would you like to update it?"
4. "Our consultations are completely free with no obligation. Are you open to having our specialist visit this week?"
5. "What's the best address for your home?" (get full address)

Score the lead 1-10:
- 10: Owns home + safety concern + wants aesthetic update + eager for appointment
- 8-9: Owns home + one of safety/aesthetic + open to visit  
- 7: Owns home + open to consultation
- Below 7: Renter, or strongly resistant, or not interested

Extract:
- lead_score: [your numeric score]
- contact_name: [full name]
- phone_number: [their phone]
- street_address: [full home address]
- owns_home: [yes/no]
- safety_concern: [yes/no]
- budget_ok: [yes/no — assume yes unless they explicitly object to investment]
- summary: [one sentence summary]
```

---

## 7. Frontend setup (if running separately)

```bash
# In your React project root:
npm create vite@latest frontend -- --template react
cd frontend
# Copy geo-scheduler-full.jsx into src/App.jsx
# Add to .env:
echo "VITE_API_URL=http://localhost:3001" > .env
npm run dev
```

---

## 8. Deploying to production (optional)

Cheapest option: **Railway** (https://railway.app)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```
Railway gives you a public URL — use that as your Bland.ai webhook URL.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Check config status |
| GET | /api/leads | Get all leads |
| POST | /api/leads | Add lead manually |
| PATCH | /api/leads/:id | Update lead status |
| DELETE | /api/leads/:id | Remove lead |
| POST | /api/geocode | Convert address → lat/lng |
| POST | /api/sms/confirm | Send SMS confirmations |
| POST | /api/webhook/bland | Bland.ai calls this automatically |

---

## Monthly cost estimate

| Service | Cost |
|---------|------|
| Google Geocoding (200 addresses) | ~$1 |
| Twilio phone number | $1/mo |
| Twilio SMS (100 messages) | ~$0.80 |
| Bland.ai calls (~$0.09/min, 200 calls × 3min avg) | ~$54 |
| Railway hosting | $5/mo |
| **Total** | **~$62/mo** |

Revenue at $50k/month goal: **800:1 ROI on infrastructure**
