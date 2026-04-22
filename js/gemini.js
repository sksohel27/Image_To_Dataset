/* ─────────────────────────────────────────────────────────────
   gemini.js — Gemini Flash model picker + image extraction
               with 10-model fallback chain on quota errors
   ───────────────────────────────────────────────────────────── */

// ── Model priority list (auto-picked from your key) ───────────
const FLASH_RANK = [
  'gemini-2.5-flash', 'gemini-2.0-flash',
  'gemini-2.0-flash-lite', 'gemini-1.5-flash',
  'gemini-1.5-flash-8b'
];

// ── Hardcoded fallback chain — tried in order when quota hits ──
// These are all free-tier models. The pipeline walks down this
// list automatically whenever it gets a quota / rate-limit error.
const FALLBACK_MODELS = [
  'gemini-2.5-flash',           // #1  — best free model right now
  'gemini-2.0-flash',           // #2  — fast, widely available
  'gemini-2.0-flash-lite',      // #3  — lighter quota limits
  'gemini-2.0-flash-exp',       // #4  — experimental channel
  'gemini-1.5-flash',           // #5  — stable, very reliable
  'gemini-1.5-flash-002',       // #6  — latest 1.5 stable revision
  'gemini-1.5-flash-001',       // #7  — first 1.5 stable revision
  'gemini-1.5-flash-8b',        // #8  — smallest, highest quota
  'gemini-1.5-flash-8b-001',    // #9  — pinned 8b revision
  'gemini-1.0-pro-vision',      // #10 — legacy vision fallback
];

const SKIP_RE = /embed|tts|aqa|imagen|veo|lyria|live|audio|robotics|computer.use|customtools/i;

// ── Quota / rate-limit error detector ─────────────────────────
function isQuotaError(message) {
  return /quota|resource.?exhausted|rate.?limit|429|too.?many|billing|denied.?access|project.*denied/i
    .test(message);
}

/**
 * Lists all models on the key and picks the best free Flash model.
 * Falls back to the top of FALLBACK_MODELS if listing fails.
 *
 * @param {string} apiKey
 * @returns {Promise<string>} model name e.g. "gemini-2.5-flash"
 */
async function pickBestFreeModel(apiKey) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`
    );
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error('ListModels: ' + (e?.error?.message || r.statusText));
    }
    const data = await r.json();

    const cands = (data.models || []).filter(m => {
      const n = (m.name || '').replace('models/', '').toLowerCase();
      if (SKIP_RE.test(n)) return false;
      if (/\bpro\b/.test(n)) return false;
      // skip preview/image-generation models that need special access
      if (/image.?preview|image.?gen|generate.?image/i.test(n)) return false;
      return (m.supportedGenerationMethods || []).includes('generateContent');
    });

    if (!cands.length) throw new Error('No free Flash model found in your project.');

    function score(name) {
      const n = name.toLowerCase();
      for (let i = 0; i < FLASH_RANK.length; i++)
        if (n.startsWith(FLASH_RANK[i])) return i;
      return FLASH_RANK.length;
    }

    cands.sort((a, b) => {
      const na = a.name.replace('models/', ''), nb = b.name.replace('models/', '');
      const sa = score(na), sb = score(nb);
      if (sa !== sb) return sa - sb;
      const al = na.includes('lite') ? 1 : 0, bl = nb.includes('lite') ? 1 : 0;
      if (al !== bl) return al - bl;
      return nb.localeCompare(na);
    });

    return cands[0].name.replace('models/', '');

  } catch (err) {
    // If model listing itself fails, start with the top of our known-good list
    console.warn('pickBestFreeModel fell back to hardcoded list:', err.message);
    return FALLBACK_MODELS[0];
  }
}

/**
 * Sends one image to Gemini and extracts structured tabular data.
 *
 * @param {{ file: File, b64: string }} item
 * @param {string} model
 * @param {string} apiKey
 * @returns {Promise<Object>}  { title, columns, rows, notes }
 */
async function extractFromImage(item, model, apiKey) {
  const prompt = `You are a data extraction specialist. Analyze this image carefully.
Find all tabular data, spreadsheet content, chart data, or any structured dataset.
Return ONLY a JSON object with this exact shape:
{"title":"short dataset name","columns":["col1","col2"],"rows":[["val1","val2"]],"notes":"brief description"}

Rules:
- Infer column names if not visible in the image
- Preserve numeric values as JavaScript numbers, not strings
- Use null (not empty string "") for missing, unreadable, or blank cells
- Return ONLY valid JSON — no markdown fences, no explanation text`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: item.file.type || 'image/png', data: item.b64 } },
            { text: prompt }
          ]
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    }
  );

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e?.error?.message || resp.statusText);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Empty response from Gemini');

  return JSON.parse(text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim());
}

/**
 * Tries extractFromImage with the preferred model first, then walks
 * down FALLBACK_MODELS automatically on every quota / rate-limit error.
 *
 * @param {{ file: File, b64: string }} item
 * @param {string}   preferredModel  — model chosen by pickBestFreeModel
 * @param {string}   apiKey
 * @param {Function} onModelSwitch   — callback(newModel, attempt, total) for logging
 * @returns {Promise<{ result: Object, modelUsed: string }>}
 */
async function extractFromImageWithFallback(item, preferredModel, apiKey, onModelSwitch) {
  // Build ordered list: preferred first, then remaining fallbacks (no duplicates)
  const chain = [
    preferredModel,
    ...FALLBACK_MODELS.filter(m => m !== preferredModel)
  ];

  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];

    try {
      if (i > 0 && onModelSwitch) {
        onModelSwitch(model, i + 1, chain.length);
      }

      const result = await extractFromImage(item, model, apiKey);
      return { result, modelUsed: model };

    } catch (err) {
      lastError = err;

      if (isQuotaError(err.message)) {
        // Quota hit — silently try the next model
        if (i < chain.length - 1 && onModelSwitch) {
          onModelSwitch(chain[i + 1], i + 2, chain.length);
        }
        continue;
      }

      // Non-quota error (bad key, invalid image, parse error etc.) — fail immediately
      throw err;
    }
  }

  // Every model in the chain exhausted its quota
  throw new Error(
    `Free quota exhausted on all ${chain.length} models. ` +
    `Try again later or add billing to your Google Cloud project. ` +
    `Last error: ${lastError?.message || 'unknown'}`
  );
}