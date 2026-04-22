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

// ── JS-side column statistics (sent as reference, not computed by LLM) ───

/**
 * Pre-computes per-column stats entirely in JS so the LLM
 * receives them as a reference range rather than guessing.
 * This prevents the model from defaulting to "median for everything".
 */
function computeColStats(columns, rows) {
  return columns.map((col, ci) => {
    const vals = rows
      .map(r => r[ci])
      .filter(v => v !== null && v !== undefined && v !== '');

    const nums = vals.filter(v => typeof v === 'number');

    if (nums.length > 0) {
      const sorted = [...nums].sort((a, b) => a - b);
      const mid    = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
      const mean   = nums.reduce((a, b) => a + b, 0) / nums.length;
      // Standard deviation — measures spread, useful to detect outliers
      const std    = Math.sqrt(
        nums.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / nums.length
      );
      return {
        col, type: 'numeric',
        count: nums.length,
        mean:   +mean.toFixed(4),
        median: +median.toFixed(4),
        std:    +std.toFixed(4),
        min:    Math.min(...nums),
        max:    Math.max(...nums),
        // A sample of actual values to show real distribution shape
        sample: [...new Set(sorted)].slice(0, 8)
      };
    }

    // Categorical
    const freq = {};
    vals.forEach(v => { const k = String(v); freq[k] = (freq[k] || 0) + 1; });
    const topValues = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([value, count]) => ({ value, count }));
    return {
      col, type: 'categorical',
      count: vals.length,
      mode: topValues[0]?.value ?? null,
      topValues
    };
  });
}

/**
 * Builds per-null row-context objects so the LLM sees every
 * neighbouring value in the same row alongside each missing cell.
 */
function buildNullContexts(columns, rows, nullBatch) {
  return nullBatch.map(({ row: ri, col: ci, colName }) => {
    const rowData = {};
    columns.forEach((col, idx) => {
      if (idx === ci) return; // skip the target cell itself
      const v = rows[ri][idx];
      if (v !== null && v !== undefined && v !== '') {
        rowData[col] = v;
      }
    });

    // Also include 2 rows above and below for sequence/trend detection
    const nearby = [];
    for (let d = -2; d <= 2; d++) {
      if (d === 0) continue;
      const r = ri + d;
      if (r < 0 || r >= rows.length) continue;
      const v = rows[r][ci];
      if (v !== null && v !== undefined && v !== '') {
        nearby.push({ offset: d, value: v });
      }
    }

    return { row: ri, col: ci, column_name: colName, row_context: rowData, nearby_same_col: nearby };
  });
}

// ── Single Groq API call ──────────────────────────────────────

/**
 * Sends one batch of null locations to Groq for imputation.
 * Passes pre-computed JS column stats + per-cell row context
 * so the model cannot default to "column median for everything".
 *
 * @param {string[]} columns
 * @param {Array[]}  rows        — full dataset rows (for context)
 * @param {Object[]} nullBatch   — subset of { row, col, colName }
 * @param {string}   title
 * @param {string}   groqKey
 * @returns {Promise<Object[]>}  — imputation objects
 */
async function callGroq(columns, rows, nullBatch, title, groqKey) {
  const colStats    = computeColStats(columns, rows);
  const nullDetails = buildNullContexts(columns, rows, nullBatch);

  const prompt = `You are an expert data scientist performing contextual missing value imputation.

Dataset: "${title || 'unknown'}"
Columns: ${JSON.stringify(columns)}

────────────────────────────────────────────────
COLUMN STATISTICS (pre-computed — use as reference range only):
${JSON.stringify(colStats, null, 2)}
────────────────────────────────────────────────

CELLS TO IMPUTE — each entry includes:
  • row_context: all OTHER non-null values in the same row
  • nearby_same_col: non-null values from adjacent rows in the same column (for trend/sequence)
${JSON.stringify(nullDetails, null, 2)}

════════════════════════════════════════════════
IMPUTATION RULES — follow in strict priority order:
════════════════════════════════════════════════

RULE 1 ▸ ROW-CONTEXT INFERENCE (use this first, always):
  Examine every value in row_context. Use domain logic and column relationships
  to derive a realistic value. Example: if pH is 7.2 in a water quality row and
  you need to fill "Hardness", check what hardness looks like in rows with similar pH.
  This is the PRIMARY strategy. Most values can be filled this way.

RULE 2 ▸ SEQUENCE / TREND (use when nearby_same_col shows a pattern):
  If nearby rows in the same column form an arithmetic sequence, geometric sequence,
  or trend, interpolate/extrapolate. Do NOT use this if the nearby values are scattered.

RULE 3 ▸ CORRELATION (use when two columns are numerically related):
  If the column stats show another numeric column has a tight range and the row_context
  contains that column's value, derive the missing value from that relationship.

RULE 4 ▸ DOMAIN KNOWLEDGE (use when column name implies a known constraint):
  e.g. "Arsenic (mg/L)" in drinking water is typically 0.001–0.05. Use domain priors.
  Apply only when row context and sequence give no useful signal.

RULE 5 ▸ COLUMN STATISTICS (absolute last resort only):
  Use mean/median ONLY when rules 1–4 all fail AND you have genuinely no other signal.
  ⚠ FORBIDDEN: do NOT assign the same median/mean value to every null in a column.
  ⚠ FORBIDDEN: if multiple rows are missing the same column, each must get a DIFFERENT
    value derived individually from its own row context. Identical values across rows
    are only acceptable if the data is genuinely uniform (e.g., a constant flag column).

════════════════════════════════════════════════

Return ONLY a raw JSON object — no markdown, no backticks, no explanation text:
{"imputations":[{"row":0,"col":1,"value":"filled_value","method":"row_context|sequence|correlation|domain|statistics","confidence":"high|medium|low","reason":"one sentence explaining which row values led to this estimate"}]}

Hard constraints:
- Numeric columns → JS numbers (not quoted strings), match column precision
- Each imputed value must be individually justified by its own row_context
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
      temperature: 0.2,   // slight raise from 0.1 — allows realistic variation between rows
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