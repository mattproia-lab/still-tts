const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const SUPA_URL = 'https://zbskapivansfewegllnz.supabase.co';

// ElevenLabs v4 — prayer voice settings.
// v4 accepts only stability and similarity_boost (no speed, no style, no SSML).
const TTS_MODEL = 'eleven_v4';
const PRAYER_VOICE_ID = '3TStB8f3X3To0Uj5R7RK';
const PRAYER_VOICE_SETTINGS = { stability: 0.80, similarity_boost: 0.75 };

// v4 ignores SSML <break> tags, so convert any that arrive from the app
// into v4 audio tags: 1.2s or longer becomes a long pause, shorter a pause.
function toV4Pauses(text) {
  return text.replace(/<break\s+time="([\d.]+)s"\s*\/>/gi, function (_, secs) {
    return parseFloat(secs) >= 1.2 ? ' [long pause] ' : ' [pause] ';
  });
}

async function generateSpeech(text) {
  const elevenRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${PRAYER_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVEN_LABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: TTS_MODEL,
        voice_settings: PRAYER_VOICE_SETTINGS
      })
    }
  );
  if (!elevenRes.ok) throw new Error(`ElevenLabs error: ${await elevenRes.text()}`);
  return elevenRes.arrayBuffer();
}

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
    if (!serviceKey) {
      console.error('Cache save skipped: SUPABASE_SERVICE_KEY is not set');
      return;
    }
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
    if (!uploadRes.ok) {
      console.error('Storage upload failed:', uploadRes.status, await uploadRes.text());
      return;
    }
    const audioUrl = `${SUPA_URL}/storage/v1/object/public/voice-audio/${fileName}`;
    const insertRes = await fetch(`${SUPA_URL}/rest/v1/voice_cache`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ text_hash: textHash, audio_url: audioUrl, character })
    });
    if (!insertRes.ok) {
      console.error('voice_cache insert failed:', insertRes.status, await insertRes.text());
    }
  } catch(e) { console.error('Cache save error:', e.message); }
}

/* POST /tts — retired 2026-10-01.
 * The character voices (Companion, Amma Sophia, Deeper) are now text-only.
 * This route stays for older installed builds: it answers 200 with no audio,
 * so those builds quietly restore the button and keep the text reply on screen.
 * Never return 401/402 here — old builds turn 402 into an "Add audio credit" offer. */
app.post('/tts', (req, res) => {
  res.status(200).json({
    audio: null,
    url: null,
    cached: false,
    silent: true,
    reason: 'character_voice_retired'
  });
});

app.post('/office-tts', async (req, res) => {
  try {
    const { text, cacheKey } = req.body;
    if (!text || !cacheKey) return res.status(400).json({ error: 'text and cacheKey required' });

    const cached = await checkCache(cacheKey);
    if (cached) return res.json({ url: cached, cached: true });

    const audioBuffer = await generateSpeech(toV4Pauses(text.trim()));
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    saveCache(cacheKey, audioBuffer, 'office').catch(console.error);

    res.json({ audio: audioBase64, cached: false });

  } catch (err) {
    console.error('Office TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/rosary-tts', async (req, res) => {
  try {
    const { id, scripture, body } = req.body;
    if (!id || !body) return res.status(400).json({ error: 'id and body required' });

    // Cache by meditation id — fixed corpus, generated once ever
    const cacheKey = `rosary-${id}`;
    const cached = await checkCache(cacheKey);
    if (cached) return res.json({ url: cached, cached: true });

    // Scripture, a long pause, then the meditation with short pauses between lines
    const text =
      (scripture ? scripture.trim() + ' [long pause] ' : '') +
      body.trim().replace(/\n/g, ' [pause] ');

    const audioBuffer = await generateSpeech(text);
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    saveCache(cacheKey, audioBuffer, 'rosary').catch(console.error);

    res.json({ audio: audioBase64, cached: false });

  } catch (err) {
    console.error('Rosary TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Still TTS running on port ${PORT}`));
