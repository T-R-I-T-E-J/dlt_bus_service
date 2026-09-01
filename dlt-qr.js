/* dlt-qr.js — a real QR Code encoder (ISO/IEC 18004), byte mode, EC level M,
   versions 1–6. Produces a genuine scannable symbol; no decorative fallback.

   window.DLTQR.matrix(text) -> { size, get(x,y) }
   window.DLTQR.draw(canvas, text, opts) -> draws with a 4-module quiet zone.

   Capacity (level M, byte mode): v1 14 · v2 26 · v3 42 · v4 62 · v5 84 · v6 106.
   Versions >= 7 need the 18-bit version-info block, which we deliberately do not
   implement: boarding tokens are short and staying under v6 keeps this honest. */
(function () {
  'use strict';

  /* total codewords, data codewords (M), and EC block layout per version */
  const VER = {
    1: { total: 26,  data: 16,  blocks: [[1, 16]] },
    2: { total: 44,  data: 28,  blocks: [[1, 28]] },
    3: { total: 70,  data: 44,  blocks: [[1, 44]] },
    4: { total: 100, data: 64,  blocks: [[2, 32]] },
    5: { total: 134, data: 86,  blocks: [[2, 43]] },
    6: { total: 172, data: 108, blocks: [[4, 27]] },
  };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

  /* ---- GF(256), primitive polynomial 0x11D ---- */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  function generator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }

  function ecc(data, n) {
    const g = generator(n);
    const res = new Array(data.length + n).fill(0);
    for (let i = 0; i < data.length; i++) res[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const f = res[i];
      if (f === 0) continue;
      for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], f);
    }
    return res.slice(data.length);
  }

  /* ---- bit stream ---- */
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function utf8(text) {
    const out = [];
    for (const ch of String(text)) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function codewords(bytes) {
    let version = 0;
    for (let v = 1; v <= 6; v++) {
      if (bytes.length <= VER[v].data - 2) { version = v; break; }
    }
    if (!version) throw new Error('DLTQR: payload too long for v1-v6 (' + bytes.length + ' bytes)');

    const spec = VER[version];
    const buf = new BitBuf();
    buf.put(4, 4);                       // byte mode
    buf.put(bytes.length, 8);            // count indicator, versions 1-9
    bytes.forEach(b => buf.put(b, 8));

    const cap = spec.data * 8;
    for (let i = 0; i < 4 && buf.bits.length < cap; i++) buf.bits.push(0);   // terminator
    while (buf.bits.length % 8) buf.bits.push(0);
    const dcw = [];
    for (let i = 0; i < buf.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | buf.bits[i + j];
      dcw.push(b);
    }
    const PAD = [0xec, 0x11];
    let p = 0;
    while (dcw.length < spec.data) dcw.push(PAD[p++ % 2]);

    /* split into EC blocks, interleave */
    const blocks = [];
    let at = 0;
    spec.blocks.forEach(([count, size]) => {
      for (let i = 0; i < count; i++) {
        blocks.push(dcw.slice(at, at + size));
        at += size;
      }
    });
    const ecLen = (spec.total - spec.data) / blocks.length;
    const ecBlocks = blocks.map(b => ecc(b, ecLen));

    const out = [];
    const maxData = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxData; i++) blocks.forEach(b => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < ecLen; i++) ecBlocks.forEach(b => out.push(b[i]));
    return { version, cw: out };
  }

  /* ---- module placement ---- */
  function build(version, cw) {
    const size = 21 + (version - 1) * 4;
    const m = [], fn = [];
    for (let i = 0; i < size; i++) { m.push(new Array(size).fill(0)); fn.push(new Array(size).fill(0)); }
    const set = (x, y, v) => { m[y][x] = v ? 1 : 0; fn[y][x] = 1; };

    const finder = (ox, oy) => {
      for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx, y = oy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const on = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
                   (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
                   (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
        set(x, y, on);
      }
    };
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    for (let i = 8; i < size - 8; i++) {                 // timing
      set(i, 6, i % 2 === 0);
      set(6, i, i % 2 === 0);
    }

    const al = ALIGN[version];
    for (const cy of al) for (const cx of al) {
      if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
        set(cx + dx, cy + dy, on);
      }
    }

    set(8, size - 8, 1);                                  // dark module
    for (let i = 0; i < 9; i++) {                         // reserve format areas
      if (!fn[i][8]) set(8, i, 0);
      if (!fn[8][i]) set(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
      /* second format copy: row 8 running in from the right, and column 8
         running up from the bottom. The guards must test the cell being
         written, not its mirror — swapping them (as this once did) overwrote
         the dark module and left one format cell holding a data bit, which
         produced symbols that looked right and decoded nowhere. */
      if (!fn[8][size - 1 - i]) set(size - 1 - i, 8, 0);
      if (!fn[size - 1 - i][8]) set(8, size - 1 - i, 0);
    }

    /* data, upward/downward two-module columns, skipping column 6 */
    const bits = [];
    cw.forEach(b => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); });
    let bi = 0, up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < size; k++) {
        const y = up ? size - 1 - k : k;
        for (const x of [col, col - 1]) {
          if (fn[y][x]) continue;
          m[y][x] = bi < bits.length ? bits[bi++] : 0;
        }
      }
      up = !up;
    }
    return { size, m, fn };
  }

  const MASK = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function formatBits(mask) {
    /* level M = 0b00, so the 5 data bits are 00 + mask */
    let data = (0 << 3) | mask;
    let v = data << 10;
    for (let i = 4; i >= 0; i--) if (v & (1 << (i + 10))) v ^= 0x537 << i;
    return ((data << 10) | v) ^ 0x5412;
  }

  function penalty(m, size) {
    let p = 0;
    /* rule 1: runs of 5+ */
    for (let i = 0; i < size; i++) {
      for (const row of [true, false]) {
        let run = 1, prev = row ? m[i][0] : m[0][i];
        for (let j = 1; j < size; j++) {
          const v = row ? m[i][j] : m[j][i];
          if (v === prev) run++;
          else { if (run >= 5) p += 3 + (run - 5); run = 1; prev = v; }
        }
        if (run >= 5) p += 3 + (run - 5);
      }
    }
    /* rule 2: 2x2 blocks */
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) p += 3;
    }
    /* rule 3: finder-like patterns */
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const rpat = pat.slice().reverse();
    const match = (get, i, j, q) => {
      for (let k = 0; k < 11; k++) if (get(i, j + k) !== q[k]) return false;
      return true;
    };
    for (let i = 0; i < size; i++) for (let j = 0; j <= size - 11; j++) {
      const gr = (a, b) => m[a][b], gc = (a, b) => m[b][a];
      if (match(gr, i, j, pat) || match(gr, i, j, rpat)) p += 40;
      if (match(gc, i, j, pat) || match(gc, i, j, rpat)) p += 40;
    }
    /* rule 4: dark proportion */
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += m[y][x];
    const pct = (dark * 100) / (size * size);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  function matrix(text) {
    const { version, cw } = codewords(utf8(text));
    const { size, m, fn } = build(version, cw);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const t = m.map(r => r.slice());
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (!fn[y][x] && MASK[mask](x, y)) t[y][x] ^= 1;
      }
      const f = formatBits(mask);
      const put = (x, y, bit) => { t[y][x] = bit; };
      for (let i = 0; i < 15; i++) {
        const bit = (f >> i) & 1;
        if (i < 6) put(8, i, bit);
        else if (i === 6) put(8, 7, bit);
        else if (i === 7) put(8, 8, bit);
        else if (i === 8) put(7, 8, bit);
        else put(14 - i, 8, bit);
      }
      for (let i = 0; i < 15; i++) {
        const bit = (f >> i) & 1;
        if (i < 8) put(size - 1 - i, 8, bit);
        else put(8, size - 15 + i, bit);
      }
      put(8, size - 8, 1);
      const score = penalty(t, size);
      if (!best || score < best.score) best = { score, t, mask };
    }
    const grid = best.t;
    return { size, version, mask: best.mask, get: (x, y) => grid[y][x] === 1, grid };
  }

  function draw(canvas, text, opts) {
    if (!canvas) return null;
    const o = opts || {};
    const dark = o.dark || '#0E1014', light = o.light || '#FFFFFF', quiet = o.quiet == null ? 4 : o.quiet;
    let qr;
    try { qr = matrix(text); }
    catch (err) { console.warn('DLTQR', err); return null; }
    const modules = qr.size + quiet * 2;
    const px = Math.max(1, Math.floor(canvas.width / modules));
    const off = Math.floor((canvas.width - px * modules) / 2);
    const g = canvas.getContext('2d');
    g.fillStyle = light; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = dark;
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
      if (qr.get(x, y)) g.fillRect(off + (x + quiet) * px, off + (y + quiet) * px, px, px);
    }
    return qr;
  }

  window.DLTQR = { matrix, draw };
})();
