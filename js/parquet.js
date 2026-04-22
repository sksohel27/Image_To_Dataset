/* ─────────────────────────────────────────────────────────────
   parquet.js — Parquet binary writer (pure JS, no deps)
   ───────────────────────────────────────────────────────────── */

/**
 * Writes a minimal but valid Apache Parquet file from columns + rows.
 * Supports DOUBLE (Float64) and BYTE_ARRAY (string) column types.
 *
 * @param {string[]} columns  - Array of column names
 * @param {Array[]}  rows     - 2D array of row values
 * @returns {Uint8Array}      - Raw Parquet binary
 */
function writeParquet(columns, rows) {
  const te = new TextEncoder();
  const PAR1 = new Uint8Array([80, 65, 82, 49]); // "PAR1" magic bytes
  const N = rows.length;

  // Detect numeric columns (all values are null or number)
  const isDouble = columns.map((_, ci) =>
    rows.every(r => r[ci] == null || typeof r[ci] === 'number')
  );

  // ── Thrift varint encoding helpers ───────────────────────
  function varint(b, n) {
    while (n > 127) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    b.push(n & 0x7f);
  }

  function zigzag(b, n) {
    varint(b, n >= 0 ? n * 2 : -2 * n - 1);
  }

  function fieldHeader(b, prev, id, type) {
    const delta = id - prev;
    if (delta >= 1 && delta <= 15) b.push((delta << 4) | type);
    else { b.push(type); zigzag(b, id); }
  }

  const fi32  = (b, p, id, v) => { fieldHeader(b, p, id, 5); zigzag(b, v); return id; };
  const fi64  = (b, p, id, v) => { fieldHeader(b, p, id, 6); zigzag(b, v); return id; };
  const fstr  = (b, p, id, v) => {
    const by = te.encode(v);
    fieldHeader(b, p, id, 8); varint(b, by.length);
    for (const x of by) b.push(x);
    return id;
  };
  const flist = (b, p, id, et, sz) => {
    fieldHeader(b, p, id, 9);
    if (sz < 15) b.push((sz << 4) | et);
    else { b.push(0xf0 | et); varint(b, sz); }
    return id;
  };
  const fstruct = (b, p, id) => { fieldHeader(b, p, id, 12); return id; };
  const stop = b => b.push(0);

  // ── Build page data per column ────────────────────────────
  const pageDatas = columns.map((_, ci) => {
    const b = [];
    if (isDouble[ci]) {
      const ab = new ArrayBuffer(8 * N);
      const dv = new DataView(ab);
      rows.forEach((r, i) => dv.setFloat64(i * 8, r[ci] == null ? 0 : +r[ci], true));
      for (const x of new Uint8Array(ab)) b.push(x);
    } else {
      rows.forEach(r => {
        const by = te.encode(r[ci] == null ? '' : String(r[ci]));
        b.push(by.length & 0xff, (by.length >> 8) & 0xff,
               (by.length >> 16) & 0xff, (by.length >> 24) & 0xff);
        for (const x of by) b.push(x);
      });
    }
    return new Uint8Array(b);
  });

  // ── Build page headers ────────────────────────────────────
  const pageHdrs = pageDatas.map(d => {
    const b = []; let p = 0;
    p = fi32(b, p, 1, 0);            // page type: DATA_PAGE
    p = fi32(b, p, 2, d.byteLength); // uncompressed size
    p = fi32(b, p, 3, d.byteLength); // compressed size
    p = fstruct(b, p, 5);            // data_page_header
    let dp = 0;
    dp = fi32(b, dp, 1, N);          // num_values
    dp = fi32(b, dp, 2, 0);          // encoding: PLAIN
    dp = fi32(b, dp, 3, 3);          // definition_level_encoding: RLE
    dp = fi32(b, dp, 4, 3);          // repetition_level_encoding: RLE
    stop(b); stop(b);
    return new Uint8Array(b);
  });

  // ── Combine page header + data chunks ────────────────────
  const chunks = columns.map((_, ci) => {
    const h = pageHdrs[ci], d = pageDatas[ci];
    const c = new Uint8Array(h.byteLength + d.byteLength);
    c.set(h); c.set(d, h.byteLength);
    return c;
  });

  // ── Compute byte offsets ──────────────────────────────────
  let off = 4; // skip PAR1 magic
  const offsets = chunks.map(c => { const o = off; off += c.byteLength; return o; });
  const totalData = off - 4;

  // ── Build file metadata (Thrift-encoded) ─────────────────
  const fb = []; let fp = 0;
  fp = fi32(fb, fp, 1, 2);                       // version
  fp = flist(fb, fp, 2, 12, columns.length + 1); // schema elements

  { // schema root
    let sp = 0;
    sp = fstr(fb, sp, 4, 'schema');
    sp = fi32(fb, sp, 5, columns.length);
    stop(fb);
  }

  columns.forEach((col, ci) => { // schema fields
    let sp = 0;
    sp = fi32(fb, sp, 1, isDouble[ci] ? 5 : 6); // type: DOUBLE=5, BYTE_ARRAY=6
    sp = fi32(fb, sp, 3, 0);                     // repetition: REQUIRED
    sp = fstr(fb, sp, 4, col);
    stop(fb);
  });

  fp = fi64(fb, fp, 3, N);         // num_rows
  fp = flist(fb, fp, 4, 12, 1);    // row groups

  { // row group
    let rp = 0;
    rp = flist(fb, rp, 1, 12, columns.length); // column chunks

    columns.forEach((col, ci) => {
      let cp = 0;
      cp = fi64(fb, cp, 2, offsets[ci]); // file_offset
      cp = fstruct(fb, cp, 3);           // meta_data
      {
        let mp = 0;
        mp = fi32(fb, mp, 1, isDouble[ci] ? 5 : 6);
        mp = flist(fb, mp, 2, 5, 1); zigzag(fb, 0); // encodings
        mp = flist(fb, mp, 3, 8, 1);
        const cb = te.encode(col); varint(fb, cb.length);
        for (const x of cb) fb.push(x);             // path_in_schema
        mp = fi32(fb, mp, 4, 0);                     // codec: UNCOMPRESSED
        mp = fi64(fb, mp, 5, N);                     // num_values
        mp = fi64(fb, mp, 6, chunks[ci].byteLength); // total_uncompressed_size
        mp = fi64(fb, mp, 7, chunks[ci].byteLength); // total_compressed_size
        mp = fi64(fb, mp, 9, offsets[ci]);           // data_page_offset
        stop(fb);
      }
      stop(fb);
    });

    rp = fi64(fb, rp, 2, totalData); // total_byte_size
    rp = fi64(fb, rp, 3, N);         // num_rows
    stop(fb);
  }
  stop(fb);

  // ── Assemble final binary ─────────────────────────────────
  const footer = new Uint8Array(fb);
  const flen = new Uint8Array(4);
  new DataView(flen.buffer).setInt32(0, footer.byteLength, true);

  const parts = [PAR1, ...chunks, footer, flen, PAR1];
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
  return out;
}

/**
 * Trigger a browser download of raw bytes.
 * @param {Uint8Array} bytes
 * @param {string} filename
 */
function dlParquet(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}