/* ─────────────────────────────────────────────────────────────
   groq.js — Groq null imputation via llama-3.3-70b-versatile
             Fixes:
             • max_tokens raised to 6000 (was 2000 — caused truncation)
             • JSON truncation recovery — salvages partial responses
             • Auto-batching when nulls > 25 (multiple smaller calls)
   ───────────────────────────────────────────────────────────── */

const GROQ_MODEL    = 'llama-3.3-70b-versatile';
const GROQ_API      = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MAX_TOK  = 6000;   // raised from 2000 — prevents mid-JSON truncation
const BATCH_SIZE    = 20;     // max nulls per Groq call (keeps response within token budget)

// ── JSON recovery helpers ─────────────────────────────────────

/**
 * Extracts every complete {...} object from a string that may be
 * truncated mid-array. Used as a fallback when JSON.parse fails.
 *
 * @param {string} text
 * @returns {Object[]}
 */
function extractPartialImputations(text) {
  const objects = [];
  let depth = 0, start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          // Only keep objects that look like valid imputation entries
          if (typeof obj.row === 'number' && typeof obj.col === 'number' && 'value' in obj) {
            objects.push(obj);
          }
        } catch {
          // Malformed object — skip it
        }
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Tries JSON.parse first; if that fails, attempts to close the
 * truncated string and re-parse; finally falls back to object extraction.
 *
 * @param {string} text  — raw text from Groq
 * @returns {Object[]}   — array of imputation objects (may be partial)
 */
function parseGroqResponse(text) {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // ── Attempt 1: clean parse ────────────────────────────────
  try {
    const parsed = JSON.parse(cleaned);
    return parsed.imputations || [];
  } catch { /* fall through */ }

  // ── Attempt 2: close truncated JSON ──────────────────────
  // Find the last complete imputation object, close the array + root object
  try {
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace > 0) {
      // Strip everything after the last complete }, then close the structure
      const trimmed = cleaned.slice(0, lastBrace + 1);
      const repaired = trimmed + ']}';
      const parsed = JSON.parse(repaired);
      if (parsed.imputations && Array.isArray(parsed.imputations)) {
        return parsed.imputations;
      }
    }
  } catch { /* fall through */ }

  // ── Attempt 3: extract individual objects ─────────────────
  const recovered = extractPartialImputations(cleaned);
  if (recovered.length > 0) return recovered;

  // Nothing salvageable
  throw new Error('Could not parse Groq response (all recovery attempts failed)');
}

// ── Single Groq API call ──────────────────────────────────────

/**
 * Sends one batch of null locations to Groq for imputation.
 *
 * @param {string[]} columns
 * @param {Array[]}  rows        — full dataset rows (for context)
 * @param {Object[]} nullBatch   — subset of { row, col, colName }
 * @param {string}   title
 * @param {string}   groqKey
 * @returns {Promise<Object[]>}  — imputation objects
 */
async function callGroq(columns, rows, nullBatch, title, groqKey) {
  // Compact data preview (max 50 rows, nulls marked)
  const previewRows = rows.slice(0, 50).map((row, ri) =>
    row.map((v, ci) =>
      (v === null || v === undefined || v === '') ? `NULL[r${ri}c${ci}]` : v
    )
  );

  const prompt = `You are a data scientist specializing in missing value imputation.

Dataset: "${title || 'unknown'}"
Columns: ${JSON.stringify(columns)}
Data (up to 50 rows, NULLs marked as NULL[rROWcCOL]):
${JSON.stringify(previewRows)}

Fill ONLY these ${nullBatch.length} missing value(s):
${JSON.stringify(nullBatch.map(l => ({ row: l.row, col: l.col, column_name: l.colName })))}

Imputation strategies (choose best per cell):
1. NUMERIC → median of column, or linear interpolation if sequential, or regression if correlated
2. CATEGORICAL/TEXT → mode (most frequent), or infer from sibling columns in the same row
3. DATE/TIME → detect interval pattern (monthly, weekly, annual) and fill accordingly
4. Use column name semantics for realistic values
5. Use cross-column inference when multiple columns are populated in the same row

Return ONLY a raw JSON object — absolutely no markdown, no backticks, no explanation:
{"imputations":[{"row":0,"col":1,"value":"filled_value","method":"median|mode|interpolation|correlation|pattern|inference|domain","confidence":"high|medium|low","reason":"one sentence"}]}

Critical:
- Numeric columns → numeric values (JS numbers, not quoted strings)
- Match existing precision/format in the same column
- No placeholder text — be realistic and domain-appropriate
- Output ONLY the JSON object, nothing before or after it`;

  const resp = await fetch(GROQ_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${groqKey}`
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens:  GROQ_MAX_TOK
    })
  });

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error('Groq API: ' + (e?.error?.message || resp.statusText));
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Empty response from Groq');

  return parseGroqResponse(text);
}

// ── Main export ───────────────────────────────────────────────

/**
 * Uses Groq's LLM to intelligently impute null/missing values.
 * Automatically batches large null sets into multiple API calls
 * so each call stays within the token budget.
 *
 * @param {{ title: string, columns: string[], rows: Array[] }} extracted
 * @param {string} groqKey
 * @returns {Promise<{ rows: Array[], imputations: Object[] }>}
 */
async function imputeNullsWithGroq(extracted, groqKey) {
  const { title, columns, rows } = extracted;

  // ── Collect all null locations ────────────────────────────
  const nullLocations = [];
  rows.forEach((row, ri) => {
    row.forEach((val, ci) => {
      if (val === null || val === undefined || val === '') {
        nullLocations.push({ row: ri, col: ci, colName: columns[ci] });
      }
    });
  });

  if (nullLocations.length === 0) return { rows, imputations: [] };

  // ── Split into batches of BATCH_SIZE ──────────────────────
  const batches = [];
  for (let i = 0; i < nullLocations.length; i += BATCH_SIZE) {
    batches.push(nullLocations.slice(i, i + BATCH_SIZE));
  }

  // ── Pre-compute numeric columns ───────────────────────────
  const colIsNumeric = columns.map((_, ci) =>
    rows.filter(r => r[ci] !== null && r[ci] !== undefined && r[ci] !== '')
        .every(r => typeof r[ci] === 'number')
  );

  // ── Process batches sequentially ─────────────────────────
  const allImputations = [];
  const newRows = rows.map(r => [...r]); // deep copy

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];

    try {
      const imputations = await callGroq(columns, newRows, batch, title, groqKey);

      imputations.forEach(imp => {
        if (imp.row < 0 || imp.row >= newRows.length) return;
        if (imp.col < 0 || imp.col >= columns.length) return;

        let val = imp.value;

        // Coerce to number if column is numeric
        if (colIsNumeric[imp.col] && typeof val === 'string' && !isNaN(Number(val))) {
          val = Number(val);
        }

        newRows[imp.row][imp.col] = val;
        allImputations.push({ ...imp, value: val });
      });

    } catch (batchErr) {
      // One batch failing shouldn't abort the others
      // Re-throw only if it's the sole batch (caller logs the warning)
      if (batches.length === 1) throw batchErr;
      console.warn(`Groq batch ${b + 1}/${batches.length} failed:`, batchErr.message);
    }
  }

  return { rows: newRows, imputations: allImputations };
}