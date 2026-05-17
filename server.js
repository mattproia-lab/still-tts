const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const SUPA_URL = 'https://zbskapivansfewegllnz.supabase.co';

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

app.post('/tts', async (req, res) => {
  try {
    const { text, character } = req.body;

    if (!text || !character) {
      return res.status(400).json({ error: 'text and character required' });
    }
    if (!VOICE_IDS[character]) {
      return res.status(400).json({ error: `Unknown character: ${character}` });
    }

    const elevenLabsKey = process.env.ELEVEN_LABS_API_KEY;
    const textHash = hashText(text.trim());

    // Check cache first
    const cachedUrl = await checkCache(textHash);
    if (cachedUrl) {
      return res.json({ url: cachedUrl, cached: true });
    }

    // Generate via ElevenLabs v3
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
          text: text.trim(),
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

    // Cache in background
    saveCache(textHash, audioBuffer, character).catch(console.error);

    res.json({ audio: audioBase64, cached: false });

  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/office-tts', async (req, res) => {
  try {
    const { text, cacheKey } = req.body;
    if (!text || !cacheKey) return res.status(400).json({ error: 'text and cacheKey required' });

    const elevenLabsKey = process.env.ELEVEN_LABS_API_KEY;

    // Check cache by date key
    const cached = await checkCache(cacheKey);
    if (cached) return res.json({ url: cached, cached: true });

    // Generate with Office voice — more reverent settings than characters
    const officeVoiceId = 'RTFg9niKcgGLDwa3RFlz';
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