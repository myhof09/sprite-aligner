// gif.js — minimal animated GIF89a encoder (global palette, LZW, per-frame delay, optional transparency, loop).
'use strict';
const GIF = (() => {
  /**
   * frames: array of Uint8Array palette indices (w*h each); palette: [[r,g,b], ...] (<= 256);
   * delaysMs: per-frame durations; transparent: palette index drawn as transparent, or -1;
   * loop: true = repeat forever (default), false = play once and stay on the last frame.
   * Returns a Uint8Array of the .gif file.
   */
  function encode(w, h, frames, palette, delaysMs, transparent = -1, loop = true) {
    const out = [];
    const u8 = (...b) => out.push(...b), u16 = v => out.push(v & 255, (v >> 8) & 255);
    const str = s => { for (const ch of s) out.push(ch.charCodeAt(0)); };
    let bits = 1;
    while ((1 << bits) < palette.length) bits++;
    str('GIF89a'); u16(w); u16(h);
    u8(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);            // global colour table follows
    for (let i = 0; i < (1 << bits); i++) u8(...(palette[i] || [0, 0, 0]));
    if (loop) { u8(0x21, 0xff, 11); str('NETSCAPE2.0'); u8(3, 1, 0, 0, 0); }  // loop forever (no block = play once)
    frames.forEach((idx, f) => {
      const hasT = transparent >= 0;
      // graphic control: disposal 2 (clear to background) so transparent frames do not smear
      u8(0x21, 0xf9, 4, (2 << 2) | (hasT ? 1 : 0)); u16(Math.max(2, Math.round(delaysMs[f] / 10))); u8(hasT ? transparent : 0, 0);
      u8(0x2c); u16(0); u16(0); u16(w); u16(h); u8(0);
      const minCode = Math.max(2, bits);
      u8(minCode);
      const data = lzw(idx, minCode);
      for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); u8(n); for (let j = 0; j < n; j++) out.push(data[i + j]); }
      u8(0);
    });
    u8(0x3b);
    return new Uint8Array(out);
  }

  function lzw(indices, minCode) {
    const clear = 1 << minCode, eoi = clear + 1, out = [];
    let size = minCode + 1, next = eoi + 1, cur = 0, curBits = 0;
    const dict = new Map();
    const emit = c => { cur |= c << curBits; curBits += size; while (curBits >= 8) { out.push(cur & 255); cur >>= 8; curBits -= 8; } };
    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = (prefix << 8) | k, v = dict.get(key);
      if (v !== undefined) { prefix = v; continue; }
      emit(prefix);
      if (next < 4096) {
        dict.set(key, next++);
        if (next > (1 << size) && size < 12) size++;
      } else {
        emit(clear); dict.clear(); size = minCode + 1; next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix); emit(eoi);
    if (curBits > 0) out.push(cur & 255);
    return out;
  }

  return { encode };
})();
