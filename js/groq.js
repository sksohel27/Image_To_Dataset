/* ─────────────────────────────────────────────────────────────
   groq.js — Groq null imputation via llama-3.3-70b-versatile
   ───────────────────────────────────────────────────────────── */

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_API   = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Uses Groq's LLM to intelligently impute null/missing values
 * in an extracted dataset using statistical reasoning, column
 * correlations, sequence patterns, and domain inference.
 *
 * @param {{ title: string, columns: string[], rows: Array[] }} extracted
 * @param {string} groqKey
 * @returns {Promise<{ rows: Array[], imputations: Object[] }>}
 */
async function imputeNullsWithGroq(extracted, groqKey) {
  const { columns, rows } = extracted;

  // ── Find null locations ───────────────────────────────────
  const nullLocations = [];
  rows.forEach((row, ri) => {
    row.forEach((val, ci) => {
      if (val === null || val === undefined || val === '') {
        nullLocations.push({ row: ri, col: ci, colName: columns[ci] });
      }
    });
  });

  if (nullLocations.length === 0) return { rows, imputations: [] };

  // ── Build compact preview for the prompt (max 50 rows) ───
  const previewRows = rows.slice(0, 50).map((row, ri) =>
    row.map((v, ci) =>
      (v === null || v === undefined || v === '') ? `NULL[r${ri}c${ci}]` : v
    )
  );

  const prompt = `You are a data scientist specializing in missing value imputation.

Dataset: "${extracted.title || 'unknown'}"
Columns: ${JSON.stringify(columns)}
Data (up to 50 rows shown, NULLs marked as NULL[rROWcCOL]):
${JSON.stringify(previewRows)}

Missing values to fill (${nullLocations.length} total):
${JSON.stringify(nullLocations.map(l => ({ row: l.row, col: l.col, column_name: l.colName })))}

Imputation strategies to apply (choose the best per cell):
1. NUMERIC columns → use median of existing column values, or linear interpolation if sequential, or regression if correlated with another numeric column
2. CATEGORICAL/TEXT columns → use mode (most frequent value), or infer from sibling columns in the same row using domain logic
3. DATE/TIME columns → detect the sequence pattern (e.g. monthly, weekly, annual) and fill accordingly
4. Use the column name's semantic meaning to guide realistic values
5. If a row has enough other populated columns, use cross-column inference

Return ONLY a JSON object — no markdown, no explanation:
{
  "imputations": [
    {
      "row": 0,
      "col": 1,
      "value": "imputed_value_here",
      "method": "median|mode|interpolation|correlation|pattern|inference|domain",
      "confidence": "high|medium|low",
      "reason": "one-sentence explanation"
    }
  ]
}

Critical rules:
- Numeric columns must receive numeric values (numbers, not quoted strings)
- Match the data type and precision of existing values in the same column
- Be realistic and contextually appropriate — no placeholder text`;

  const resp = await fetch(GROQ_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${groqKey}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000
    })
  });

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error('Groq API: ' + (e?.error?.message || resp.statusText));
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Empty response from Groq');

  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const result = JSON.parse(cleaned);

  // ── Apply imputations (deep copy rows) ───────────────────
  const newRows = rows.map(r => [...r]);

  // Pre-compute which columns are purely numeric
  const colIsNumeric = columns.map((_, ci) =>
    rows.filter(r => r[ci] !== null && r[ci] !== undefined && r[ci] !== '')
        .every(r => typeof r[ci] === 'number')
  );

  (result.imputations || []).forEach(imp => {
    if (imp.row < 0 || imp.row >= newRows.length) return;
    if (imp.col < 0 || imp.col >= columns.length) return;

    let val = imp.value;

    // Coerce to number if the column is numeric
    if (colIsNumeric[imp.col] && typeof val === 'string' && !isNaN(Number(val))) {
      val = Number(val);
    }

    newRows[imp.row][imp.col] = val;
  });

  return { rows: newRows, imputations: result.imputations || [] };
}