/* ─────────────────────────────────────────────────────────────
   gemini.js — Gemini Flash model picker + image extraction
   ───────────────────────────────────────────────────────────── */

const FLASH_RANK = [
  'gemini-3.1-flash', 'gemini-3-flash',
  'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'
];

const SKIP_RE = /embed|tts|aqa|imagen|veo|lyria|live|audio|robotics|computer.use|customtools/i;

/**
 * Lists all models on the key and picks the best free Flash model.
 * Skips Pro, embedding, audio, and vision-only models.
 *
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<string>} model name e.g. "gemini-2.5-flash"
 */
async function pickBestFreeModel(apiKey) {
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
    return (m.supportedGenerationMethods || []).includes('generateContent');
  });

  if (!cands.length)
    throw new Error('No free Flash model found. Verify your key at aistudio.google.com');

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
}

/**
 * Sends an image to Gemini and extracts structured tabular data.
 * Returns { title, columns, rows, notes }
 *
 * @param {{ file: File, b64: string }} item
 * @param {string} model   - model name e.g. "gemini-2.5-flash"
 * @param {string} apiKey
 * @returns {Promise<Object>}
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