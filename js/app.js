/* ─────────────────────────────────────────────────────────────
   app.js — Main orchestrator: state, events, pipeline
   ───────────────────────────────────────────────────────────── */

// ── Global state ──────────────────────────────────────────────

let imageFiles  = []; // Array of { file, b64, dataURL }
let results     = []; // Array of result objects
let cachedModel = null;

window._pq = {}; // parquet bytes keyed by result index, for inline download

// ── DOM refs ──────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const apiKeyEl       = $('apiKey');
const apiStatusEl    = $('apiStatus');
const groqKeyEl      = $('groqKey');
const groqStatusEl   = $('groqStatus');
const groqNoteEl     = $('groqRequiredNote');
const imputeToggleEl = $('imputeToggle');
const fileInputEl    = $('fileInput');
const uploadZoneEl   = $('uploadZone');
const convertBtnEl   = $('convertBtn');
const resultsSection = $('resultsSection');
const resultsCont    = $('resultsContainer');
const mergeCardEl    = $('mergeCard');
const mergeDescEl    = $('mergeDesc');

// ── Nav scroll shadow ──────────────────────────────────────────

window.addEventListener('scroll', () => {
  document.querySelector('.site-nav')
    .classList.toggle('scrolled', window.scrollY > 8);
});

// ── Collapsible config sections ───────────────────────────────

document.querySelectorAll('.config-section-header').forEach(header => {
  header.addEventListener('click', () => {
    header.classList.toggle('open');
    const body = header.nextElementSibling;
    body.classList.toggle('open');
  });
});

// ── Gemini API key ─────────────────────────────────────────────

apiKeyEl.addEventListener('input', () => {
  const v = apiKeyEl.value.trim();
  if (v.startsWith('AIza') && v.length > 20) {
    apiStatusEl.innerHTML = '<span class="dot"></span> Valid — ready';
    apiStatusEl.className = 'api-key-status ok';
  } else {
    apiStatusEl.innerHTML = 'Not set &nbsp;·&nbsp; <a href="https://aistudio.google.com/app/apikey" target="_blank">Get free key ↗</a>';
    apiStatusEl.className = 'api-key-status';
  }
  updateConvertBtn();
});

// ── Groq API key ───────────────────────────────────────────────

groqKeyEl.addEventListener('input', () => {
  const v = groqKeyEl.value.trim();
  if (v.startsWith('gsk_') && v.length > 20) {
    groqStatusEl.innerHTML = '<span class="dot"></span> Valid — ready';
    groqStatusEl.className = 'api-key-status ok';
    imputeToggleEl.disabled = false;
    if (groqNoteEl) groqNoteEl.style.display = 'none';
  } else {
    groqStatusEl.innerHTML = 'Not set &nbsp;·&nbsp; <a href="https://console.groq.com/keys" target="_blank">Get free key ↗</a>';
    groqStatusEl.className = 'api-key-status';
    imputeToggleEl.disabled = true;
    imputeToggleEl.checked  = false;
    if (groqNoteEl) groqNoteEl.style.display = '';
  }
  updateConvertBtn();
});

// ── File upload ───────────────────────────────────────────────

uploadZoneEl.addEventListener('click', () => fileInputEl.click());

uploadZoneEl.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZoneEl.classList.add('dragover');
});

uploadZoneEl.addEventListener('dragleave', () => {
  uploadZoneEl.classList.remove('dragover');
});

uploadZoneEl.addEventListener('drop', e => {
  e.preventDefault();
  uploadZoneEl.classList.remove('dragover');
  addFiles([...e.dataTransfer.files]);
});

fileInputEl.addEventListener('change', () => {
  addFiles([...fileInputEl.files]);
  fileInputEl.value = '';
});

function addFiles(files) {
  const allowed = files.filter(f => f.type.startsWith('image/'));
  const slots   = 5 - imageFiles.length;

  if (slots <= 0) {
    log('Max 5 images reached. Remove one to add more.', 'warn');
    return;
  }

  allowed.slice(0, slots).forEach(f => {
    const reader = new FileReader();
    reader.onload = e => {
      imageFiles.push({
        file:    f,
        b64:     e.target.result.split(',')[1],
        dataURL: e.target.result
      });
      renderQueue(imageFiles, results, () => fileInputEl.click());
      updateConvertBtn();
    };
    reader.readAsDataURL(f);
  });

  if (allowed.length > slots)
    log(`Only ${slots} slot(s) available — added first ${slots}.`, 'warn');
}

// Exposed globally so queue-item remove buttons can call it
window.removeFile = function(idx) {
  imageFiles.splice(idx, 1);
  renderQueue(imageFiles, results, () => fileInputEl.click());
  updateConvertBtn();
};

function updateConvertBtn() {
  const k = apiKeyEl.value.trim();
  convertBtnEl.disabled = !(imageFiles.length > 0 && k.startsWith('AIza') && k.length > 20);
}

// ── Main pipeline ─────────────────────────────────────────────

convertBtnEl.addEventListener('click', async () => {
  convertBtnEl.disabled   = true;
  convertBtnEl.innerHTML  = '<span class="spinner"></span> Processing…';
  results = [];
  resultsCont.innerHTML = '';
  resultsSection.classList.remove('show');
  mergeCardEl.classList.remove('show');
  document.getElementById('logLines').innerHTML = '';
  window._pq = {};

  const doImpute = imputeToggleEl.checked && !imputeToggleEl.disabled;
  const groqKey  = groqKeyEl.value.trim();

  try {
    log('Pipeline started', 'accent');
    log(`Queue: ${imageFiles.length} image(s)`, 'info');
    if (doImpute) log('⚡ Groq null imputation enabled (llama-3.3-70b-versatile)', 'groq');

    // Pick best Gemini model
    log('Selecting best free Flash model…', 'info');
    cachedModel = await pickBestFreeModel(apiKeyEl.value.trim());
    log(`✓ Model: ${cachedModel}`, 'ok');

    // Process each image
    for (let i = 0; i < imageFiles.length; i++) {
      const item = imageFiles[i];
      log(`─── [${i + 1}/${imageFiles.length}] ${item.file.name}`, 'accent');
      updateQueueItem(i, 'processing');

      try {
        // Step 1: Gemini extraction
        log('  → Sending to Gemini…', 'info');
        let extracted = await extractFromImage(item, cachedModel, apiKeyEl.value.trim());
        log(`  ✓ "${extracted.title}" — ${extracted.columns.length} cols, ${extracted.rows.length} rows`, 'ok');
        if (extracted.notes) log(`  📝 ${extracted.notes}`, 'warn');

        // Count nulls before imputation
        const nullCount = extracted.rows.reduce(
          (a, row) => a + row.filter(v => v == null || v === '').length, 0
        );

        let imputations = [];

        // Step 2: Groq imputation (if enabled and nulls exist)
        if (doImpute && nullCount > 0) {
          log(`  Found ${nullCount} null(s) → sending to Groq…`, 'groq');
          updateQueueItem(i, 'imputing');
          try {
            const impResult = await imputeNullsWithGroq(extracted, groqKey);
            extracted   = { ...extracted, rows: impResult.rows };
            imputations = impResult.imputations;
            log(`  ⚡ Groq filled ${imputations.length}/${nullCount} null(s)`, 'groq');
            imputations.forEach(imp => {
              log(`    ✦ ${extracted.columns[imp.col]} [row ${imp.row + 1}]: "${imp.value}" (${imp.method}, ${imp.confidence})`, 'groq');
            });
          } catch (groqErr) {
            log(`  ⚠ Groq failed: ${groqErr.message} — continuing without imputation`, 'warn');
          }
        } else if (doImpute && nullCount === 0) {
          log('  No nulls found — skipping Groq step', 'info');
        }

        // Step 3: Build Parquet
        log('  Building Parquet…', 'info');
        const parquetBytes = writeParquet(extracted.columns, extracted.rows);
        const filename     = safeName(extracted.title, `output_${i + 1}`);
        log(`  ✓ ${filename} (${formatBytes(parquetBytes.byteLength)})`, 'ok');

        results.push({ idx: i, extracted, parquetBytes, filename, error: null, imputations, originalNullCount: nullCount });
        window._pq[i] = parquetBytes;
        updateQueueItem(i, 'done');

      } catch (err) {
        log(`  ✗ ${err.message}`, 'err');
        results.push({ idx: i, extracted: null, parquetBytes: null, filename: null, error: err.message, imputations: [], originalNullCount: 0 });
        updateQueueItem(i, 'error');
      }
    }

    // Render result cards
    resultsSection.classList.add('show');
    results.forEach(res => resultsCont.appendChild(buildResultCard(res, imageFiles[res.idx])));

    // Merge option (2+ successful results)
    const ok = results.filter(r => !r.error);
    if (ok.length >= 2) {
      const allCols = ok.map(r => r.extracted.columns.join('|'));
      const same    = allCols.every(c => c === allCols[0]);
      mergeDescEl.textContent = same
        ? `All ${ok.length} tables share identical columns (${ok[0].extracted.columns.length} fields) — ideal for stacking into one file.`
        : `${ok.length} tables with different schemas. Merging will union all columns and fill gaps with empty values.`;
      mergeCardEl.classList.add('show');
    }

    // Summary
    const totalImputed = results.reduce((a, r) => a + (r.imputations?.length || 0), 0);
    log('─'.repeat(32), 'info');
    log(`✓ Done — ${ok.length}/${imageFiles.length} file(s) ready.${totalImputed > 0 ? ` ⚡ ${totalImputed} null(s) imputed.` : ''}`, 'ok');

  } catch (err) {
    log('✗ Fatal: ' + err.message, 'err');
  } finally {
    convertBtnEl.disabled  = false;
    convertBtnEl.innerHTML = '▶ &nbsp; Extract Data &amp; Generate Parquet Files';
    updateConvertBtn();
  }
});

// ── Merge all results ─────────────────────────────────────────

document.getElementById('mergeBtn').addEventListener('click', () => {
  const ok = results.filter(r => !r.error);
  if (ok.length < 2) return;

  const allCols = []; const seen = new Set();
  ok.forEach(r => r.extracted.columns.forEach(c => {
    if (!seen.has(c)) { seen.add(c); allCols.push(c); }
  }));

  const mergedRows = [];
  ok.forEach(r => r.extracted.rows.forEach(row => {
    mergedRows.push(allCols.map(col => {
      const ci = r.extracted.columns.indexOf(col);
      return ci >= 0 ? row[ci] : null;
    }));
  }));

  const bytes = writeParquet(allCols, mergedRows);
  dlParquet(bytes, 'merged_output.parquet');
  log(`↓ merged_output.parquet — ${mergedRows.length} rows, ${allCols.length} cols, ${formatBytes(bytes.byteLength)}`, 'ok');
});