// pxf-starters.js — five starter recipes in pxf.graph@1 (written for this tool; edit them freely).
'use strict';
const PXF_STARTERS = (() => {
  const n = (id, type, params) => ({ id, type, x: 0, y: 0, params });
  const L = (...pairs) => pairs.map(([f, t, p = 0]) => ({ f, t, p }));
  const game = (blend, impactFrame, size) => ({ pivot: [0.5, 0.5], logicalSize: size, blend, impactFrame });

  return {
    slash: {
      format: 'pxf.graph@1', name: '베기 궤적',
      settings: { size: 64, frames: 12, fps: 24, loop: false },
      nodes: [
        n('arc', 'Arc', { x: 0.5, y: 0.55, radius: 25, start: -160, sweep: 200, aspect: 0.75, rot: -15, taper: 1.2,
          thick: { k: [[0, 4], [3, 13, 'out'], [8, 6], [11, 2]] },
          head: { k: [[0, 0, 'out3'], [4, 1.05], [11, 1.3]] },
          tail: { k: [[0, 0.3], [4, 0.7], [11, 0.4]] } }),
        n('echo', 'Echo', { copies: 2, step: 1, decay: 0.5 }),
        n('pal', 'Palette', { colors: ['#1b3a6b', '#3f7fd1', '#9fd3ff', '#f2fbff'], cutoff: 0.15 }),
        n('fade', 'Tint', { amount: 0, opacity: { k: [[0, 1], [6, 1, 'in'], [11, 0]] } }),
        n('out', 'Output', { alpha: 'soft', threshold: 0.1 }),
      ],
      links: L(['arc', 'echo'], ['echo', 'pal'], ['pal', 'fade'], ['fade', 'out']),
      game: game('add', 3, 64),
    },

    spark: {
      format: 'pxf.graph@1', name: '타격 불꽃',
      settings: { size: 48, frames: 12, fps: 24, loop: false },
      nodes: [
        n('core', 'Shape', { shape: 'star', points: 4, size2: 0.25, rot: 45, size: { k: [[0, 0, 'out3'], [2, 10], [5, 5, 'in'], [8, 0]] } }),
        n('ring', 'Shape', { shape: 'ring', size2: 0.1, size: { k: [[0, 2, 'out'], [6, 16], [11, 20]] }, intensity: { k: [[0, 0.6], [5, 0.35], [9, 0]] } }),
        n('sparks', 'Particles', { count: 10, seed: 41, emit: 'burst', start: 0.05, life: 0.6, lifeVar: 0.2, speed: 2.2, speedVar: 0.4,
          drag: 0.12, sizeA: 1, sizeB: 1, pshape: 'streak', stretch: 4, fade: 'out', bright: 0.9 }),
        n('b1', 'Blend', { mode: 'max' }),
        n('b2', 'Blend', { mode: 'max' }),
        n('pal', 'Palette', { colors: ['#7a2b0c', '#e0661c', '#ffc14a', '#fff6d6'], cutoff: 0.1 }),
        n('out', 'Output', { alpha: 'hard', threshold: 0.5 }),
      ],
      links: L(['core', 'b1', 0], ['ring', 'b1', 1], ['b1', 'b2', 0], ['sparks', 'b2', 1], ['b2', 'pal'], ['pal', 'out']),
      game: game('add', 2, 48),
    },

    lightning: {
      format: 'pxf.graph@1', name: '번개 내려치기',
      settings: { size: 64, frames: 16, fps: 24, loop: false },
      nodes: [
        n('bolt', 'Lightning', { x0: 0.45, y0: 0, x1: 0.52, y1: 0.9, detail: 5, jag: 0.45, branch: 0.5, branchLen: 0.35, seed: 77, rate: 2,
          thick: { k: [[0, 1], [3, 2], [8, 2], [12, 1]] }, grow: { k: [[0, 0, 'out3'], [3, 1]] }, intensity: { k: [[0, 1], [9, 1, 'in'], [13, 0.3]] } }),
        n('glow', 'Glow', { radius: 2, strength: 1.4 }),
        n('flash', 'Shape', { shape: 'circle', x: 0.52, y: 0.9, aspect: 0.45, falloff: 0.6, size: { k: [[2, 0, 'out3'], [4, 9], [9, 4, 'in'], [13, 0]] } }),
        n('mix', 'Blend', { mode: 'max' }),
        n('pal', 'Palette', { colors: ['#1a1f5c', '#3550d6', '#6fb6ff', '#e8f6ff'], cutoff: 0.12 }),
        n('fade', 'Tint', { amount: 0, opacity: { k: [[0, 1], [10, 1, 'in'], [15, 0]] } }),
        n('out', 'Output', { alpha: 'soft', threshold: 0.1 }),
      ],
      links: L(['bolt', 'glow'], ['glow', 'mix', 0], ['flash', 'mix', 1], ['mix', 'pal'], ['pal', 'fade'], ['fade', 'out']),
      game: game('add', 3, 64),
    },

    fire: {
      format: 'pxf.graph@1', name: '불꽃 폭발',
      settings: { size: 64, frames: 20, fps: 24, loop: false },
      nodes: [
        n('core', 'Shape', { shape: 'circle', y: 0.62, falloff: 0.7, size: { k: [[0, 2, 'out3'], [4, 14], [12, 10, 'in'], [19, 0]] } }),
        n('noise', 'Noise', { type: 'fbm', scaleX: 4, scaleY: 4, octaves: 3, seed: 12, scrollY: -2, contrast: 1.6 }),
        n('lick', 'Displace', { mode: 'dir', angle: -90, amount: 6, center: 0.5 }),
        n('embers', 'Particles', { count: 18, seed: 9, emit: 'burst', start: 0.05, life: 0.6, lifeVar: 0.4, area: 'circle', y: 0.62, aw: 10, ah: 10,
          angle: -90, spread: 110, speed: 1.2, speedVar: 0.5, gravity: -0.03, drag: 0.04, sizeA: 2, sizeB: 0, fade: 'out', bright: 0.8 }),
        n('mix', 'Blend', { mode: 'max' }),
        n('pal', 'Palette', { colors: ['#3d0a0a', '#a3231b', '#e8591c', '#ffb030', '#fff1b8'], cutoff: 0.12 }),
        n('out', 'Output', { alpha: 'soft', threshold: 0.15 }),
      ],
      links: L(['core', 'lick', 0], ['noise', 'lick', 1], ['lick', 'mix', 0], ['embers', 'mix', 1], ['mix', 'pal'], ['pal', 'out']),
      game: game('normal', 4, 64),
    },

    dust: {
      format: 'pxf.graph@1', name: '먼지 퍼짐',
      settings: { size: 48, frames: 16, fps: 24, loop: false },
      nodes: [
        n('puffs', 'Particles', { count: 12, seed: 5, emit: 'burst', start: 0, life: 0.8, lifeVar: 0.2, area: 'line', y: 0.78, aw: 20,
          angle: -90, spread: 160, speed: 0.8, speedVar: 0.5, gravity: -0.01, drag: 0.1, sizeA: 4, sizeB: 8, pshape: 'circle', fade: 'out', bright: 0.7 }),
        n('dith', 'Dither', { levels: 4, pattern: 'bayer4' }),
        n('pal', 'Palette', { colors: ['#5b4a3a', '#9c8466', '#d8c7a5'], cutoff: 0.1 }),
        n('out', 'Output', { alpha: 'hard', threshold: 0.5 }),
      ],
      links: L(['puffs', 'dith'], ['dith', 'pal'], ['pal', 'out']),
      game: game('normal', 0, 48),
    },
  };
})();
