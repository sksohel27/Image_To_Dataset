/* ─────────────────────────────────────────────────────────────
   ui.js — UI helpers: formatting, log, queue, result cards
   ───────────────────────────────────────────────────────────── */

// ── Formatting ────────────────────────────────────────────────

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function safeName(title, fallback) {
  return (title || fallback).replace(/[^a-z0-9_\-]/gi, '_').toLowerCase() + '.parquet';
}

// ── Column statistics ─────────────────────────────────────────

function colStats(rows, ci, isNum) {
  const vals = rows.map(r => r[ci]).filter(v => v != null && v !== '');
  if (!vals.length) return { nulls: rows.length, unique: 0, min: '—', max: '—' };
  const nulls = rows.length - vals.length;
  const unique = new Set(vals.map(String)).size;
  if (isNum) {
    const nums = vals.map(Number).filter(n => !isNaN(n));
    return { nulls, unique, min: Math.min(...nums).toLocaleString(), max: Math.max(...nums).toLocaleString() };
  }
  const sorted = [...vals].sort((a, b) => String(a).localeCompare(String(b)));
  return { nulls, unique, min: String(sorted[0]).substring(0, 22), max: String(sorted[sorted.length - 1]).substring(0, 22) };
}

// ── Log console ───────────────────────────────────────────────

const logBox   = () => document.getElementById('logBox');
const logLines = () => document.getElementById('logLines');

function log(msg, type = 'info') {
  logBox().classList.add('show');
  const now = new Date();
  const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg ${type}">${msg}</span>`;
  logLines().appendChild(line);
  logLines().scrollTop = logLines().scrollHeight;
}

// ── Queue rendering ───────────────────────────────────────────

function updateQueueItem(idx, status) {
  const el = document.getElementById(`qi-${idx}`);
  if (!el) return;
  el.className = `queue-item ${status}`;
  const s = el.querySelector('.queue-status-bar');
  if (!s) return;
  s.className = `queue-status-bar ${status}`;
  const labels = {
    processing: '⟳  Extracting…',
    imputing:   '⚡  Imputing nulls…',
    done:       '✓  Done',
    error:      '✗  Error',
    pending:    '—  Pending'
  };
  s.textContent = labels[status] || '—  Pending';
}

function renderQueue(imageFiles, results, onAddClick) {
  const section  = document.getElementById('queueSection');
  const grid     = document.getElementById('queueGrid');
  const countEl  = document.getElementById('queueCount');

  grid.innerHTML = '';
  countEl.textContent = `${imageFiles.length} / 5`;

  if (!imageFiles.length) { section.classList.remove('show'); return; }
  section.classList.add('show');

  imageFiles.forEach((item, i) => {
    const res = results.find(r => r.idx === i);
    const sc  = res ? (res.error ? 'error' : 'done') : 'pending';
    const st  = res ? (res.error ? '✗  Error' : '✓  Done') : '—  Pending';

    const div = document.createElement('div');
    div.className = `queue-item ${sc}`;
    div.id = `qi-${i}`;
    div.innerHTML = `
      <img class="queue-img" src="${item.dataURL}" alt=""/>
      <div class="queue-meta">
        <div class="queue-name">${item.file.name}</div>
        <div class="queue-size">${formatBytes(item.file.size)}</div>
      </div>
      <div class="queue-status-bar ${sc}">${st}</div>
      <button class="queue-remove" onclick="window.removeFile(${i})">✕</button>`;
    grid.appendChild(div);
  });

  if (imageFiles.length < 5) {
    const add = document.createElement('button');
    add.className = 'queue-add';
    add.innerHTML = '<span style="font-size:24px;line-height:1">＋</span><span>Add image</span>';
    add.onclick = onAddClick;
    grid.appendChild(add);
  }
}

// ── Result card builder ───────────────────────────────────────

function buildResultCard(res, item) {
  const { extracted, parquetBytes, filename, error, idx, imputations, originalNullCount } = res;
  const card = document.createElement('div');
  card.className = 'result-card open';

  // ── Error state ──────────────────────────────────────────
  if (error) {
    card.innerHTML = `
      <div class="result-card-header">
        <img class="result-thumb" src="${item.dataURL}" alt=""/>
        <div class="result-card-info">
          <div class="result-card-title">${item.file.name}</div>
          <div class="result-card-meta">Extraction failed</div>
        </div>
        <span class="result-badge err">Failed</span>
        <span class="result-chevron">▶</span>
      </div>
      <div class="result-body">
        <p style="color:var(--rust);font-size:13px">✗ ${error}</p>
      </div>`;
    card.querySelector('.result-card-header').addEventListener('click', () => card.classList.toggle('open'));
    return card;
  }

  // ── Success state ────────────────────────────────────────
  const { columns, rows, title, notes } = extracted;
  const isDouble = columns.map((_, ci) => rows.every(r => r[ci] == null || typeof r[ci] === 'number'));
  const numCols  = isDouble.filter(Boolean).length;
  const txtCols  = columns.length - numCols;

  const totalCells = columns.length * rows.length;
  const nullCells  = rows.reduce((a, row) => a + row.filter(v => v == null || v === '').length, 0);
  const comp       = totalCells > 0 ? (((totalCells - nullCells) / totalCells) * 100).toFixed(1) : '100.0';
  const compClass  = parseFloat(comp) >= 95 ? 'teal' : parseFloat(comp) >= 80 ? 'rust' : 'rust';

  const wasImputed = imputations && imputations.length > 0;
  const imputedSet = new Set((imputations || []).map(i => `${i.row}_${i.col}`));

  // Badge
  const badge = wasImputed
    ? `<span class="result-badge imputed">✦ Imputed</span>`
    : `<span class="result-badge ok">✓ Ready</span>`;

  // Stats grid
  const statsHTML = `
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Rows</div>
        <div class="stat-value">${rows.length.toLocaleString()}</div>
        <div class="stat-unit">data records</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Columns</div>
        <div class="stat-value">${columns.length}</div>
        <div class="stat-unit">fields</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Numeric</div>
        <div class="stat-value teal">${numCols}</div>
        <div class="stat-unit">DOUBLE type</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Text</div>
        <div class="stat-value rust">${txtCols}</div>
        <div class="stat-unit">STRING type</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Completeness</div>
        <div class="stat-value ${compClass} sm">${comp}%</div>
        <div class="stat-unit">non-null cells</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">File Size</div>
        <div class="stat-value sm">${formatBytes(parquetBytes.byteLength)}</div>
        <div class="stat-unit">parquet binary</div>
      </div>
      ${wasImputed ? `
      <div class="stat-box" style="border-color:rgba(184,92,56,.25)">
        <div class="stat-label" style="color:var(--rust)">Imputed</div>
        <div class="stat-value rust sm">${imputations.length}</div>
        <div class="stat-unit">cells filled by AI</div>
      </div>` : ''}
    </div>`;

  // Column breakdown table
  const colRowsHTML = columns.map((col, ci) => {
    const s    = colStats(rows, ci, isDouble[ci]);
    const type = isDouble[ci] ? 'number' : 'string';
    return `<tr>
      <td style="color:var(--stone)">${ci + 1}</td>
      <td style="font-weight:500">${col}</td>
      <td><span class="type-pill ${type}">${type}</span></td>
      <td>${s.unique.toLocaleString()}</td>
      <td>${s.nulls}</td>
      <td style="color:var(--warm-grey)">${s.min}</td>
      <td style="color:var(--warm-grey)">${s.max}</td>
    </tr>`;
  }).join('');

  // Preview table (first 15 rows, imputed cells highlighted)
  const previewRowsHTML = rows.slice(0, 15).map((row, ri) =>
    `<tr>${columns.map((_, ci) => {
      const isImputed = imputedSet.has(`${ri}_${ci}`);
      return `<td class="${isImputed ? 'imputed' : ''}">${row[ci] ?? ''}${isImputed ? ' ✦' : ''}</td>`;
    }).join('')}</tr>`
  ).join('');

  const moreNote = rows.length > 15
    ? `<tr><td colspan="${columns.length}" style="color:var(--stone);font-style:italic;padding:8px 16px;font-size:12px">… ${rows.length - 15} more rows — download to view all</td></tr>`
    : '';

  // Imputation report
  let imputationHTML = '';
  if (wasImputed) {
    const impRowsHTML = imputations.slice(0, 20).map(imp => `
      <tr>
        <td>Row ${imp.row + 1}, <em>${columns[imp.col] || 'col' + imp.col}</em></td>
        <td style="color:var(--rust);font-weight:500">${imp.value}</td>
        <td><span class="type-pill string" style="font-size:9px">${imp.method || 'auto'}</span></td>
        <td style="color:var(--warm-grey);font-size:12px">${imp.reason || '—'}</td>
        <td style="color:${imp.confidence === 'high' ? 'var(--teal)' : imp.confidence === 'medium' ? 'var(--rust)' : 'var(--stone)'}">${imp.confidence || '—'}</td>
      </tr>`).join('');
    const moreImp = imputations.length > 20
      ? `<tr><td colspan="5" style="color:var(--stone);font-size:11px;font-style:italic;padding:6px 16px">… ${imputations.length - 20} more imputations</td></tr>` : '';

    imputationHTML = `
      <div class="imputation-report">
        <div class="imputation-report-title">⚡ Groq Imputation Report — ${imputations.length} of ${originalNullCount} null(s) filled</div>
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr><th>Location</th><th>Filled Value</th><th>Method</th><th>Reason</th><th>Confidence</th></tr></thead>
            <tbody>${impRowsHTML}${moreImp}</tbody>
          </table>
        </div>
      </div>`;
  }

  // Notes banner
  const notesHTML = notes
    ? `<div class="notes-banner">📝 ${notes}</div>` : '';

  card.innerHTML = `
    <div class="result-card-header">
      <img class="result-thumb" src="${item.dataURL}" alt=""/>
      <div class="result-card-info">
        <div class="result-card-title">${title || item.file.name}</div>
        <div class="result-card-meta">
          <span>${columns.length} columns</span>
          <span class="result-card-meta-sep"></span>
          <span>${rows.length} rows</span>
          <span class="result-card-meta-sep"></span>
          <span>${formatBytes(parquetBytes.byteLength)}</span>
          ${wasImputed ? `<span class="result-card-meta-sep"></span><span style="color:var(--rust)">${imputations.length} nulls imputed</span>` : ''}
        </div>
      </div>
      ${badge}
      <span class="result-chevron">▶</span>
    </div>
    <div class="result-body">
      ${notesHTML}
      ${imputationHTML}
      ${statsHTML}

      <div class="sub-label">Column breakdown</div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Unique</th><th>Nulls</th><th>Min / First</th><th>Max / Last</th></tr></thead>
          <tbody>${colRowsHTML}</tbody>
        </table>
      </div>

      <div class="sub-label">
        Data preview
        <span style="color:var(--stone);text-transform:none;letter-spacing:0;font-size:10px;font-weight:300">
          — first ${Math.min(15, rows.length)} of ${rows.length} rows
          ${wasImputed ? ' · <span style="color:var(--rust)">✦ = AI-imputed</span>' : ''}
        </span>
      </div>
      <div class="preview-table-wrap">
        <table class="data-table">
          <thead><tr>${columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>${previewRowsHTML}${moreNote}</tbody>
        </table>
      </div>

      <button class="btn btn-download" onclick="dlParquet(window._pq[${idx}], '${filename}')">
        ↓ &nbsp; Download ${filename}
      </button>
    </div>`;

  card.querySelector('.result-card-header').addEventListener('click', () => card.classList.toggle('open'));
  return card;
}