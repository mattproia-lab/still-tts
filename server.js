const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const SUPA_URL = 'https://zbskapivansfewegllnz.supabase.co';

// ─────────────────────────────────────────────────────────────────────────────
// SET THIS to YOUR real ElevenLabs cost per 1,000 characters, in CENTS.
// You're on eleven_v3 (~1 credit per character) — typically ~16–22¢ per 1,000
// chars depending on plan. Compute it as:
//   (your monthly plan $  ÷  characters that plan includes)  × 1000 × 100
// or use your per-character overage rate. This single number sets what users pay
// to HEAR a reply. Reading replies in text is free. Setting it a touch high
// builds a small buffer for payment-processing fees on top-ups.
const COST_PER_1000_CHARS_CENTS = 20;   // ← VERIFY against your ElevenLabs plan
// ─────────────────────────────────────────────────────────────────────────────

const VOICE_IDS = {
  companion:  'ePiPWpzcHZrcqRzFrgQg',
  ammaSophia: 'Y5JXXvUD3rmjDInkLVA2',
  deeper:     'DzcRs71mIqvZ5truEdVC'
};

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ── Credit metering helpers ──────────────────────────────────────────────────

// Resolve the Supabase user id from their access token
async function getUserId(token) {
  if (!token) return null;
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    const res = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u && u.id ? u.id : null;
  } catch (e) { return null; }
}

// Atomic deduct — returns new balance, or -1 if insufficient (or no wallet yet)
async function spendCredit(uid, cents) {
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    const res = await fetch(`${SUPA_URL}/rest/v1/rpc/spend_voice_credit`, {
      method: 'POST',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: uid, p_cents: cents })
    });
    if (!res.ok) return -1;
    return await res.json();
  } catch (e) { return -1; }
}

// Put credit back if generation fails (a failed reply is never charged)
async function refundCredit(uid, cents) {
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    await fetch(`${SUPA_URL}/rest/v1/rpc/add_voice_credit`, {
      method: 'POST',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: uid, p_cents: cents })
    });
  } catch (e) { console.error('Refund failed:', e.message); }
}

// ── Caching (unchanged) ──────────────────────────────────────────────────────

async function checkCache(textHash) {
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    const res = await fetch(
      `${SUPA_URL}/rest/v1/voice_cache?text_hash=eq.${textHash}&limit=1`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.length > 0 ? data[0].audio_url : null;
  } catch(e) { return null; }
}

async function saveCache(textHash, audioBuffer, character) {
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    const fileName = `${textHash}-${Date.now()}.mp3`;
    const uploadRes = await fetch(
      `${SUPA_URL}/storage/v1/object/voice-audio/${fileName}`,
      {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'audio/mpeg',
          'x-upsert': 'true'
        },
        body: audioBuffer
      }
    );
    if (!uploadRes.ok) return;
    const audioUrl = `${SUPA_URL}/storage/v1/object/public/voice-audio/${fileName}`;
    await fetch(`${SUPA_URL}/rest/v1/voice_cache`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ text_hash: textHash, audio_url: audioUrl, character })
    });
  } catch(e) { console.error('Cache save error:', e.message); }
}

// ── Voice replies: METERED ───────────────────────────────────────────────────

app.post('/tts', async (req, res) => {
  try {
    const { text, character, access_token } = req.body;

    if (!text || !character) {
      return res.status(400).json({ error: 'text and character required' });
    }
    if (!VOICE_IDS[character]) {
      return res.status(400).json({ error: `Unknown character: ${character}` });
    }

    const elevenLabsKey = process.env.ELEVEN_LABS_API_KEY;
    const clean = text.trim();
    const textHash = hashText(clean);

    // 1) Cached audio costs nothing to serve → return it FREE, no charge.
    const cachedUrl = await checkCache(textHash);
    if (cachedUrl) {
      return res.json({ url: cachedUrl, cached: true });
    }

    // 2) Fresh generation is metered. Identify the user from their token.
    const uid = await getUserId(access_token);
    if (!uid) return res.status(401).json({ error: 'auth_required' });

    // 3) Cost = characters × your rate. Deduct FIRST (atomic); refund if it fails.
    const cost = Math.max(1, Math.ceil(clean.length / 1000 * COST_PER_1000_CHARS_CENTS));
    const remaining = await spendCredit(uid, cost);
    if (remaining < 0) {
      return res.status(402).json({ error: 'insufficient_balance' });
    }

    // 4) Generate via ElevenLabs v3. Refund on any failure so it's never charged.
    try {
      const voiceId = VOICE_IDS[character];
      const elevenRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': elevenLabsKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
          },
          body: JSON.stringify({
            text: clean,
            model_id: 'eleven_v3',
            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.75,
              style: 0.55,
              use_speaker_boost: true,
              speed: 0.82
            }
          })
        }
      );

      if (!elevenRes.ok) {
        const err = await elevenRes.text();
        throw new Error(`ElevenLabs error: ${err}`);
      }

      const audioBuffer = await elevenRes.arrayBuffer();
      const audioBase64 = Buffer.from(audioBuffer).toString('base64');

      // Cache in background (a repeat of identical text is free next time)
      saveCache(textHash, audioBuffer, character).catch(console.error);

      res.json({ audio: audioBase64, cached: false, balance_cents: remaining });

    } catch (genErr) {
      await refundCredit(uid, cost);   // failed generation → give the credit back
      console.error('TTS generation error:', genErr.message);
      res.status(502).json({ error: 'generation_failed' });
    }

  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Office / Vigils: FREE (bundled in the subscription, heavily cached) ───────

app.post('/office-tts', async (req, res) => {
  try {
    const { text, cacheKey } = req.body;
    if (!text || !cacheKey) return res.status(400).json({ error: 'text and cacheKey required' });

    const elevenLabsKey = process.env.ELEVEN_LABS_API_KEY;

    // Check cache by date key
    const cached = await checkCache(cacheKey);
    if (cached) return res.json({ url: cached, cached: true });

    // Generate with Office voice — more reverent settings than characters
    const officeVoiceId = '3TStB8f3X3To0Uj5R7RK';
    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${officeVoiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': elevenLabsKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: text.trim(),
          model_id: 'eleven_v3',
          voice_settings: {
            stability: 0.80,
            similarity_boost: 0.75,
            style: 0.20,
            use_speaker_boost: true,
            speed: 0.78
          }
        })
      }
    );

    if (!elevenRes.ok) throw new Error(`ElevenLabs error: ${await elevenRes.text()}`);

    const audioBuffer = await elevenRes.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    saveCache(cacheKey, audioBuffer, 'office').catch(console.error);

    res.json({ audio: audioBase64, cached: false });

  } catch (err) {
    console.error('Office TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Still TTS running on port ${PORT}`));
