'use strict';
/*
 * Editor Video Semplice
 * Tutto gira nel browser: anteprima su <canvas>, audio con Web Audio API,
 * esportazione con MediaRecorder (canvas + audio mixato).
 */

/* =========================================================
 * Utility
 * ======================================================= */
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, p) => a + (b - a) * p;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const even = n => Math.round(n / 2) * 2;
let uid = 1;

function fmtTime(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/* =========================================================
 * Animazioni foto (stile "Ken Burns" / Movie Maker), versione delicata.
 * s  = zoom relativo alla foto "intera" (1 = la foto tocca i bordi dello
 *      schermo; < 1 = un po' più piccola, con un margine nero)
 * dx/dy = spostamento in frazione dello schermo (0 = centrata).
 * Lo zoom non supera mai 1 e la posizione viene limitata ai bordi,
 * quindi la foto resta sempre visibile per intero.
 * ======================================================= */
const ANIMATIONS = {
  none:      { label: 'Nessuna (ferma)',             from: { s: 1,   dx: 0,     dy: 0 },     to: { s: 1,   dx: 0,     dy: 0 } },
  zoomIn:    { label: 'Avvicinamento lento',         from: { s: .9,  dx: 0,     dy: 0 },     to: { s: 1,   dx: 0,     dy: 0 } },
  zoomOut:   { label: 'Allontanamento lento',        from: { s: 1,   dx: 0,     dy: 0 },     to: { s: .9,  dx: 0,     dy: 0 } },
  panRight:  { label: 'Scivola verso destra',        from: { s: .93, dx: -.025, dy: 0 },     to: { s: .93, dx: .025,  dy: 0 } },
  panLeft:   { label: 'Scivola verso sinistra',      from: { s: .93, dx: .025,  dy: 0 },     to: { s: .93, dx: -.025, dy: 0 } },
  panDown:   { label: 'Scivola verso il basso',      from: { s: .93, dx: 0,     dy: -.025 }, to: { s: .93, dx: 0,     dy: .025 } },
  panUp:     { label: "Scivola verso l'alto",        from: { s: .93, dx: 0,     dy: .025 },  to: { s: .93, dx: 0,     dy: -.025 } },
  zoomInTL:  { label: 'Avvicinamento verso alto-sx', from: { s: .9,  dx: .02,   dy: .02 },   to: { s: .97, dx: -.015, dy: -.015 } },
  zoomInBR:  { label: 'Avvicinamento verso basso-dx', from: { s: .9, dx: -.02,  dy: -.02 },  to: { s: .97, dx: .015,  dy: .015 } },
  zoomOutTR: { label: 'Allontanamento da alto-dx',   from: { s: .97, dx: .015,  dy: -.015 }, to: { s: .9,  dx: -.02,  dy: .02 } },
  zoomOutBL: { label: 'Allontanamento da basso-sx',  from: { s: .97, dx: -.015, dy: .015 },  to: { s: .9,  dx: .02,   dy: -.02 } },
};
const MOVING_ANIMS = Object.keys(ANIMATIONS).filter(k => k !== 'none');
const randomAnim = () => MOVING_ANIMS[Math.floor(Math.random() * MOVING_ANIMS.length)];
const easeInOut = p => 0.5 - Math.cos(Math.PI * p) / 2;

/* =========================================================
 * Stato del progetto
 * ======================================================= */
const settings = {
  aspect: '16:9',
  quality: 720,
  fps: 30,
  fadeFromBlack: true,
  fadeToBlack: true,
  photoDuration: 4,
  transition: 1,
  defaultAnim: 'random',
  smoothAnim: true,
  animStrength: 1,
};
const clips = [];  // foto e video in sequenza
const music = [];  // tracce musicali
let layout = [];   // [{clip, start, dur, tr}]
let total = 0;
let selected = null; // { kind: 'clip' | 'music', id }
let pps = 40;        // pixel per secondo nella timeline

const canvas = $('#preview');
const g = canvas.getContext('2d');
const pool = $('#mediaPool');

/* =========================================================
 * Audio (Web Audio API)
 * ======================================================= */
let actx = null, master = null, exportDest = null;
function ensureAudio() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  master = actx.createGain();
  master.connect(actx.destination);
  exportDest = actx.createMediaStreamDestination();
  master.connect(exportDest);
}
function connectMedia(el) {
  ensureAudio();
  const src = actx.createMediaElementSource(el);
  const gain = actx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(master);
  return { src, gain };
}
function setGain(node, v) {
  if (!node || !actx) return;
  const p = node.gain;
  if (Math.abs(p.value - v) < 0.001) return;
  p.setTargetAtTime(v, actx.currentTime, 0.015);
}

/* =========================================================
 * Caricamento file
 * ======================================================= */
function kindOf(f) {
  const t = f.type || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv', 'm4v', 'ogv', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  return null;
}

function loadMediaEl(url, tag) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    el.preload = 'auto';
    if (tag === 'video') el.playsInline = true;
    const okEvent = tag === 'video' ? 'loadeddata' : 'loadedmetadata';
    const ok = () => { done(); resolve(el); };
    const ko = () => { done(); reject(new Error('formato non supportato dal browser')); };
    const done = () => { el.removeEventListener(okEvent, ok); el.removeEventListener('error', ko); };
    el.addEventListener(okEvent, ok);
    el.addEventListener('error', ko);
    el.src = url;
  });
}

// Alcuni file (es. WebM registrati dal browser) non dichiarano la durata.
async function fixDuration(el) {
  if (isFinite(el.duration) && el.duration > 0) return;
  await new Promise(resolve => {
    const t = setTimeout(resolve, 4000);
    const h = () => {
      if (isFinite(el.duration)) { clearTimeout(t); el.removeEventListener('durationchange', h); resolve(); }
    };
    el.addEventListener('durationchange', h);
    el.currentTime = 1e7;
  });
  el.currentTime = 0;
  if (!isFinite(el.duration)) throw new Error('impossibile leggere la durata');
}

function waitSeek(el, t) {
  return new Promise(resolve => {
    if (Math.abs(el.currentTime - t) < 0.001 && !el.seeking) return resolve();
    const h = () => { el.removeEventListener('seeked', h); resolve(); };
    el.addEventListener('seeked', h);
    el.currentTime = t;
    setTimeout(h, 3000);
  });
}

function makeThumb(src, w, h) {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, 160, 90);
  const k = Math.max(160 / w, 90 / h);
  x.drawImage(src, (160 - w * k) / 2, (90 - h * k) / 2, w * k, h * k);
  return c.toDataURL('image/jpeg', 0.7);
}

async function createImageClip(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight;
  // Riduce le foto molto grandi per un'anteprima/export più fluidi
  let src = img;
  const MAX = 2560;
  if (Math.max(w, h) > MAX && window.createImageBitmap) {
    const k = MAX / Math.max(w, h);
    try {
      src = await createImageBitmap(img, { resizeWidth: Math.round(w * k), resizeHeight: Math.round(h * k), resizeQuality: 'high' });
    } catch { src = img; }
  }
  return {
    id: uid++, type: 'image', name: file.name, url, src, w, h,
    thumb: makeThumb(img, w, h),
    duration: settings.photoDuration,
    transition: settings.transition,
    anim: settings.defaultAnim === 'random' ? randomAnim() : settings.defaultAnim,
    fit: 'contain',
  };
}

async function createVideoClip(name, url, thumb = null) {
  const el = await loadMediaEl(url, 'video');
  await fixDuration(el);
  pool.appendChild(el);
  const audio = connectMedia(el);
  el.addEventListener('seeked', () => { if (!player.playing) requestRender(); });
  if (!thumb) {
    await waitSeek(el, Math.min(1, el.duration * 0.2));
    thumb = makeThumb(el, el.videoWidth, el.videoHeight);
    await waitSeek(el, 0);
  }
  return {
    id: uid++, type: 'video', name, url, el, audio, thumb,
    w: el.videoWidth, h: el.videoHeight,
    srcDuration: el.duration, in: 0, out: el.duration,
    muted: false, volume: 1,
    transition: settings.transition, fit: 'contain',
  };
}

async function createMusic(name, url) {
  const el = await loadMediaEl(url, 'audio');
  await fixDuration(el);
  pool.appendChild(el);
  const audio = connectMedia(el);
  const lastEnd = music.reduce((m, x) => Math.max(m, x.start + (x.out - x.in)), 0);
  return {
    id: uid++, type: 'music', name, url, el, audio,
    srcDuration: el.duration, in: 0, out: el.duration,
    start: lastEnd, volume: 0.8, fadeIn: 0, fadeOut: 2,
  };
}

let loadingCount = 0;
async function addFiles(fileList) {
  ensureAudio();
  const files = [...fileList];
  let added = 0, lastSel = null;
  loadingCount += files.length;
  for (const f of files) {
    const kind = kindOf(f);
    toast(`Caricamento: ${f.name}…`, 60000);
    try {
      if (kind === 'image') {
        const c = await createImageClip(f); clips.push(c); lastSel = { kind: 'clip', id: c.id };
      } else if (kind === 'video') {
        const c = await createVideoClip(f.name, URL.createObjectURL(f)); clips.push(c); lastSel = { kind: 'clip', id: c.id };
      } else if (kind === 'audio') {
        const m = await createMusic(f.name, URL.createObjectURL(f)); music.push(m); lastSel = { kind: 'music', id: m.id };
      } else {
        toast(`Tipo di file non riconosciuto: ${f.name}`); await sleep(1500); continue;
      }
      added++;
      refresh();
    } catch (err) {
      console.error(err);
      toast(`Impossibile aprire "${f.name}": ${err.message}`, 5000);
      await sleep(1500);
    } finally {
      loadingCount--;
    }
  }
  if (added) {
    toast(`${added} file aggiunt${added === 1 ? 'o' : 'i'}`);
    if (lastSel) select(lastSel);
  }
}

async function cloneClip(c) {
  if (c.type === 'image') return { ...c, id: uid++ };
  const n = await createVideoClip(c.name, c.url, c.thumb);
  Object.assign(n, { in: c.in, out: c.out, muted: c.muted, volume: c.volume, transition: c.transition, fit: c.fit });
  return n;
}

function disposeMedia(item) {
  if (!item.el) return;
  item.el.pause();
  try { item.audio.src.disconnect(); item.audio.gain.disconnect(); } catch { /* ignore */ }
  item.el.remove();
}

/* =========================================================
 * Calcolo della timeline
 * ======================================================= */
const clipDur = c => (c.type === 'image' ? c.duration : Math.max(0.1, c.out - c.in));

function relayout() {
  layout = [];
  let prev = null;
  for (const c of clips) {
    const dur = clipDur(c);
    let start = 0, tr = 0;
    if (prev) {
      tr = Math.max(0, Math.min(c.transition || 0, dur / 2, prev.dur / 2));
      start = prev.start + prev.dur - tr;
    }
    prev = { clip: c, start, dur, tr };
    layout.push(prev);
  }
  total = prev ? prev.start + prev.dur : 0;
}

function musicLen(m) {
  const len = Math.max(0.1, m.out - m.in);
  return total > 0 ? Math.max(0, Math.min(len, total - m.start)) : len;
}

/* =========================================================
 * Player
 * ======================================================= */
const player = { playing: false, t: 0, last: 0, raf: 0 };

function isActive(L, i, t) {
  const end = L.start + L.dur;
  return t >= L.start && (t < end || (i === layout.length - 1 && t <= end));
}

function syncMedia(hard) {
  const t = player.t;
  layout.forEach((L, i) => {
    const c = L.clip;
    if (c.type !== 'video') return;
    const v = c.el;
    const local = c.in + clamp(t - L.start, 0, L.dur);
    if (isActive(L, i, t) && t < total) {
      if (player.playing) {
        if (v.paused) { v.currentTime = local; v.play().catch(() => {}); }
        else if (Math.abs(v.currentTime - local) > 0.3) v.currentTime = local;
      } else {
        if (!v.paused) v.pause();
        if (hard || Math.abs(v.currentTime - local) > 0.03) v.currentTime = local;
      }
    } else {
      if (!v.paused) v.pause();
      if (isActive(L, i, t)) { // ultimo frame
        if (Math.abs(v.currentTime - local) > 0.03) v.currentTime = local;
      } else if (t < L.start && L.start - t < 3 && !v.seeking && Math.abs(v.currentTime - c.in) > 0.05) {
        v.currentTime = c.in; // pre-caricamento della clip successiva
      }
    }
  });

  for (const m of music) {
    const el = m.el;
    const len = musicLen(m);
    const active = player.playing && t >= m.start && t < m.start + len;
    const local = m.in + (t - m.start);
    if (active) {
      if (el.paused) { el.currentTime = local; el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - local) > 0.3) el.currentTime = local;
    } else {
      if (!el.paused) el.pause();
      if (t < m.start && m.start - t < 3 && !el.seeking && Math.abs(el.currentTime - m.in) > 0.05) el.currentTime = m.in;
    }
  }
}

function drawSource(src, sw, sh, fit, kb, rot = 0) {
  const W = canvas.width, H = canvas.height;
  const k = fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const dw = sw * k * kb.s, dh = sh * k * kb.s;
  // posizione centrata + spostamento, limitata così da non uscire dallo schermo
  // (o, se la foto è più grande dello schermo, da non mostrare bordi vuoti)
  const fitPos = (avail, size, d) => {
    const pos = (avail - size) / 2 + d * avail;
    return avail >= size ? clamp(pos, 0, avail - size) : clamp(pos, avail - size, 0);
  };
  const x = fitPos(W, dw, kb.dx), y = fitPos(H, dh, kb.dy);
  if (!rot) { g.drawImage(src, x, y, dw, dh); return; }
  // fotogrammi decodificati di video girati (es. telefono in verticale)
  const side = rot === 90 || rot === 270;
  g.save();
  g.translate(x + dw / 2, y + dh / 2);
  g.rotate(rot * Math.PI / 180);
  const fw = side ? dh : dw, fh = side ? dw : dh;
  g.drawImage(src, -fw / 2, -fh / 2, fw, fh);
  g.restore();
}

// Calcola zoom/posizione della foto al punto p (0..1) dell'animazione
function photoMotion(c, p) {
  const a = ANIMATIONS[c.anim] || ANIMATIONS.none;
  const k = settings.animStrength;
  const sOf = v => 1 - (1 - v.s) * k;
  let s = lerp(sOf(a.from), sOf(a.to), p);
  // in modalità "riempi" lo zoom parte da 1 per non lasciare bordi vuoti
  if (c.fit === 'cover') s /= Math.min(sOf(a.from), sOf(a.to));
  return { s, dx: lerp(a.from.dx, a.to.dx, p) * k, dy: lerp(a.from.dy, a.to.dy, p) * k };
}

function render() {
  const t = player.t;
  const W = canvas.width, H = canvas.height;
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  if (!clips.length) {
    g.fillStyle = '#8a91a0';
    g.font = `${Math.round(H / 22)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText('Aggiungi foto e video con "＋ Foto / Video"', W / 2, H / 2);
    g.fillText('oppure trascina i file nella finestra', W / 2, H / 2 + H / 16);
  }

  layout.forEach((L, i) => {
    const c = L.clip;
    const active = isActive(L, i, t);
    // audio della clip video (con dissolvenza incrociata)
    if (c.type === 'video') {
      let gv = 0;
      if (active && !c.muted) {
        const aIn = L.tr > 0 ? clamp((t - L.start) / L.tr, 0, 1) : 1;
        const next = layout[i + 1];
        const aOut = next && next.tr > 0 && t > next.start ? clamp(1 - (t - next.start) / next.tr, 0, 1) : 1;
        gv = c.volume * aIn * aOut;
      }
      setGain(c.audio.gain, gv);
    }
    if (!active) return;

    const alpha = L.tr > 0 ? clamp((t - L.start) / L.tr, 0, 1) : 1;
    g.globalAlpha = alpha;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    if (c.type === 'image') {
      let p = clamp((t - L.start) / L.dur, 0, 1);
      if (settings.smoothAnim) p = easeInOut(p);
      drawSource(c.src, c.w, c.h, c.fit, photoMotion(c, p));
    } else {
      const ef = exportFrames.get(c.id);
      if (ef && ef.frame) {
        const side = ef.rot === 90 || ef.rot === 270;
        const fw = ef.frame.displayWidth, fh = ef.frame.displayHeight;
        drawSource(ef.frame, side ? fh : fw, side ? fw : fh, c.fit, { s: 1, dx: 0, dy: 0 }, ef.rot);
      } else if (c.el.readyState >= 2) {
        drawSource(c.el, c.el.videoWidth, c.el.videoHeight, c.fit, { s: 1, dx: 0, dy: 0 });
      }
    }
  });
  g.globalAlpha = 1;

  // dissolvenza globale da/verso nero
  let fade = 1;
  if (total > 0) {
    const fl = Math.min(1, total / 4);
    if (settings.fadeFromBlack) fade = Math.min(fade, clamp(t / fl, 0, 1));
    if (settings.fadeToBlack) fade = Math.min(fade, clamp((total - t) / fl, 0, 1));
  }
  if (fade < 1) {
    g.fillStyle = `rgba(0,0,0,${1 - fade})`;
    g.fillRect(0, 0, W, H);
  }

  // musica: volume + dissolvenze
  for (const m of music) {
    const len = musicLen(m);
    let e = 0;
    if (t >= m.start && t < m.start + len) {
      e = m.volume;
      if (m.fadeIn > 0) e *= clamp((t - m.start) / m.fadeIn, 0, 1);
      if (m.fadeOut > 0) e *= clamp((m.start + len - t) / m.fadeOut, 0, 1);
    }
    setGain(m.audio.gain, e);
  }
  if (master) setGain(master, fade);

  updateTimeUI();
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; if (!player.playing) render(); });
}

function tick(now) {
  if (!player.playing) return;
  const dt = Math.min(0.25, (now - player.last) / 1000);
  player.last = now;
  player.t += dt;
  if (player.t >= total) {
    player.t = total;
    render();
    stopPlayback();
    if (exp.running) finishExport();
    return;
  }
  syncMedia(false);
  render();
  if (exp.running) {
    $('#expProgress').value = total ? player.t / total : 0;
    $('#expStatus').textContent = `Registrazione… ${fmtTime(player.t)} / ${fmtTime(total)}`;
  }
  player.raf = requestAnimationFrame(tick);
}

function play() {
  if (!clips.length) { toast('Aggiungi prima qualche foto o video'); return; }
  ensureAudio();
  actx.resume();
  if (player.t >= total - 0.01) player.t = 0;
  player.playing = true;
  player.last = performance.now();
  syncMedia(true);
  $('#btnPlay').textContent = '⏸';
  player.raf = requestAnimationFrame(tick);
}
function stopPlayback() {
  player.playing = false;
  cancelAnimationFrame(player.raf);
  for (const c of clips) if (c.el && !c.el.paused) c.el.pause();
  for (const m of music) if (!m.el.paused) m.el.pause();
  for (const m of music) setGain(m.audio.gain, 0);
  for (const c of clips) if (c.audio) setGain(c.audio.gain, 0);
  $('#btnPlay').textContent = '▶';
}
function pause() {
  stopPlayback();
  syncMedia(true);
  requestRender();
}
function togglePlay() { player.playing ? pause() : play(); }
function seek(t) {
  player.t = clamp(t, 0, total);
  syncMedia(!player.playing);
  if (!player.playing) requestRender();
  updateTimeUI();
}

function updateTimeUI() {
  $('#timeLabel').textContent = `${fmtTime(player.t)} / ${fmtTime(total)}`;
  const sb = $('#seekBar');
  if (!seekDragging) sb.value = total ? Math.round(player.t / total * 1000) : 0;
  const x = player.t * pps;
  $('#playhead').style.transform = `translateX(${x}px)`;
  if (player.playing) {
    const sc = $('#tlScroll');
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - 60);
  }
}

/* =========================================================
 * Dimensioni del video
 * ======================================================= */
function applyCanvasSize() {
  const q = settings.quality;
  let W, H;
  switch (settings.aspect) {
    case '9:16': W = q; H = q * 16 / 9; break;
    case '1:1': W = H = q; break;
    case '4:3': H = q; W = q * 4 / 3; break;
    default: H = q; W = q * 16 / 9;
  }
  canvas.width = even(W);
  canvas.height = even(H);
  requestRender();
}

/* =========================================================
 * Timeline (interfaccia)
 * ======================================================= */
function renderTimeline() {
  const musicEnd = music.reduce((m, x) => Math.max(m, x.start + (x.out - x.in)), 0);
  const span = Math.max(total, musicEnd, 10) + 5;
  const inner = $('#tlInner');
  inner.style.width = `${span * pps}px`;

  // righello
  const ruler = $('#ruler');
  const step = pps >= 80 ? 1 : pps >= 30 ? 2 : pps >= 15 ? 5 : 10;
  let html = '';
  for (let s = 0; s <= span; s += step) {
    html += `<div class="tick" style="left:${s * pps}px">${fmtTime(s).replace(/\.\d$/, '')}</div>`;
    if (step >= 2) html += `<div class="tick minor" style="left:${(s + step / 2) * pps}px"></div>`;
  }
  ruler.innerHTML = html;

  // traccia video
  const tv = $('#trackVideo');
  tv.innerHTML = '';
  layout.forEach((L, i) => {
    const c = L.clip;
    const d = document.createElement('div');
    d.className = `clip ${c.type}` + (isSel('clip', c.id) ? ' selected' : '');
    d.style.left = `${L.start * pps}px`;
    d.style.width = `${Math.max(4, L.dur * pps)}px`;
    d.style.zIndex = i + 1;
    d.style.backgroundImage = `url(${c.thumb})`;
    d.draggable = true;
    d.dataset.id = c.id;
    const badge = c.type === 'image' ? '🖼' : (c.muted ? '🎞 🔇' : '🎞');
    d.innerHTML =
      (L.tr > 0 ? `<div class="trans" style="width:${L.tr * pps}px" title="Dissolvenza ${L.tr.toFixed(1)} s"></div>` : '') +
      `<span class="badge">${badge}</span>` +
      `<span class="label">${esc(c.name)} · ${L.dur.toFixed(1)}s</span>`;
    d.title = `${c.name}\n${L.dur.toFixed(1)} s`;
    d.addEventListener('click', e => {
      e.stopPropagation();
      select({ kind: 'clip', id: c.id });
      if (player.t < L.start || player.t > L.start + L.dur) seek(L.start + L.tr);
    });
    d.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-clip', String(c.id));
      e.dataTransfer.effectAllowed = 'move';
      d.classList.add('dragging');
    });
    d.addEventListener('dragend', () => { d.classList.remove('dragging'); $('#dropMarker').hidden = true; });
    tv.appendChild(d);
  });

  // traccia musica
  const tm = $('#trackMusic');
  tm.innerHTML = '';
  for (const m of music) {
    const d = document.createElement('div');
    d.className = 'clip music' + (isSel('music', m.id) ? ' selected' : '');
    const len = m.out - m.in;
    d.style.left = `${m.start * pps}px`;
    d.style.width = `${Math.max(4, len * pps)}px`;
    d.innerHTML = `<span class="label">♪ ${esc(m.name)} · ${len.toFixed(1)}s</span>`;
    d.title = 'Trascina per spostare la traccia nel tempo';
    attachMusicDrag(d, m);
    tm.appendChild(d);
  }
  updateTimeUI();
}

function dropIndexAt(x) {
  const t = x / pps;
  let idx = layout.length;
  for (let i = 0; i < layout.length; i++) {
    if (t < layout[i].start + layout[i].dur / 2) { idx = i; break; }
  }
  return idx;
}

function setupTimelineEvents() {
  const tv = $('#trackVideo');
  const marker = $('#dropMarker');
  tv.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-clip')) return;
    e.preventDefault();
    const x = e.clientX - tv.getBoundingClientRect().left;
    const idx = dropIndexAt(x);
    const pos = idx < layout.length ? layout[idx].start : total;
    marker.style.left = `${pos * pps}px`;
    marker.hidden = false;
  });
  tv.addEventListener('dragleave', () => { marker.hidden = true; });
  tv.addEventListener('drop', e => {
    const id = Number(e.dataTransfer.getData('text/x-clip'));
    if (!id) return;
    e.preventDefault();
    marker.hidden = true;
    const from = clips.findIndex(c => c.id === id);
    let to = dropIndexAt(e.clientX - tv.getBoundingClientRect().left);
    if (from < 0) return;
    if (to > from) to--;
    const [c] = clips.splice(from, 1);
    clips.splice(to, 0, c);
    refresh();
  });

  // click/trascinamento sul righello o su area vuota = sposta il cursore
  const scrubArea = [$('#ruler'), tv, $('#trackMusic')];
  for (const el of scrubArea) {
    el.addEventListener('pointerdown', e => {
      if (e.target.closest('.clip')) return;
      if (el !== $('#ruler')) select(null);
      const rect = $('#tlInner').getBoundingClientRect();
      const move = ev => seek((ev.clientX - rect.left) / pps);
      move(e);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}

function attachMusicDrag(d, m) {
  d.addEventListener('pointerdown', e => {
    e.preventDefault();
    const x0 = e.clientX, s0 = m.start;
    let moved = false;
    d.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      m.start = Math.max(0, Math.round((s0 + dx / pps) * 10) / 10);
      d.style.left = `${m.start * pps}px`;
    };
    const up = () => {
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      if (moved) { refresh(); if (isSel('music', m.id)) buildPanel(); }
      else select({ kind: 'music', id: m.id });
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  });
}

/* =========================================================
 * Selezione e pannello proprietà
 * ======================================================= */
const isSel = (kind, id) => selected && selected.kind === kind && selected.id === id;
function selectedItem() {
  if (!selected) return null;
  const list = selected.kind === 'clip' ? clips : music;
  return list.find(x => x.id === selected.id) || null;
}
function select(sel) {
  selected = sel;
  renderTimeline();
  buildPanel();
}

function refresh() {
  relayout();
  if (player.t > total) player.t = total;
  renderTimeline();
  seek(player.t);
}

const panel = $('#panel');

function rangeField(label, k, val, min, max, step, unit = 's') {
  return `<div class="field">
    <div class="row"><span>${label}</span><output data-o="${k}" data-u="${unit}"></output></div>
    <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}">
  </div>`;
}
function selectField(label, k, options, val) {
  const opts = Object.entries(options).map(([v, l]) => `<option value="${v}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('');
  return `<label class="field"><span>${label}</span><select data-k="${k}">${opts}</select></label>`;
}
function checkField(label, k, val) {
  return `<label class="check"><input type="checkbox" data-k="${k}"${val ? ' checked' : ''}> ${label}</label>`;
}
function fmtOut(v, unit) {
  if (unit === '%') return `${Math.round(v * 100)}%`;
  if (unit === 't') return fmtTime(v);
  if (unit === 'x') return `${Number(v).toFixed(2)}×`;
  return `${Number(v).toFixed(1)} s`;
}
function syncPanel(obj) {
  panel.querySelectorAll('output[data-o]').forEach(o => { o.textContent = fmtOut(obj[o.dataset.o], o.dataset.u); });
  panel.querySelectorAll('[data-k]').forEach(inp => {
    const v = obj[inp.dataset.k];
    if (inp.type === 'checkbox') inp.checked = !!v;
    else if (String(inp.value) !== String(v)) inp.value = v;
  });
}
function bindPanel(obj, onChange) {
  panel.querySelectorAll('[data-k]').forEach(inp => {
    const k = inp.dataset.k;
    const ev = inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input';
    inp.addEventListener(ev, () => {
      let v;
      if (inp.type === 'checkbox') v = inp.checked;
      else if (inp.type === 'range' || inp.type === 'number') v = parseFloat(inp.value);
      else v = inp.value;
      if (typeof v === 'number' && !isFinite(v)) return;
      if (/^\d+$/.test(v)) v = Number(v);
      obj[k] = v;
      onChange(k, v);
      syncPanel(obj);
    });
  });
  panel.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => actions[b.dataset.act]?.()));
  syncPanel(obj);
}

function clipLayout(c) { return layout.find(L => L.clip === c); }

function buildPanel() {
  const item = selectedItem();
  if (!item) return buildProjectPanel();

  if (selected.kind === 'music') {
    const m = item;
    const maxStart = Math.max(Math.ceil(total), Math.ceil(m.start) + 1, 1);
    panel.innerHTML = `
      <h3>♪ Traccia musicale</h3>
      <div class="sub">${esc(m.name)} · durata originale ${fmtTime(m.srcDuration)}</div>
      ${rangeField('Inizia nel video al secondo', 'start', m.start, 0, maxStart, 0.1, 't')}
      <div class="section-title">Taglio della traccia</div>
      ${rangeField('Parti dal punto', 'in', m.in, 0, m.srcDuration, 0.1, 't')}
      ${rangeField('Fermati al punto', 'out', m.out, 0, m.srcDuration, 0.1, 't')}
      <div class="section-title">Volume e dissolvenze</div>
      ${rangeField('Volume', 'volume', m.volume, 0, 1.5, 0.01, '%')}
      ${rangeField('Dissolvenza in entrata', 'fadeIn', m.fadeIn, 0, 10, 0.1)}
      ${rangeField('Dissolvenza in uscita', 'fadeOut', m.fadeOut, 0, 10, 0.1)}
      <p class="muted" style="font-size:12px">La musica viene tagliata automaticamente alla fine del video.</p>
      <div class="btnrow">
        <button class="btn small" data-act="musicToStart">Allinea all'inizio</button>
        <button class="btn small" data-act="musicToCursor">Inizia dal cursore</button>
      </div>
      <hr>
      <div class="btnrow"><button class="btn danger" data-act="remove">🗑 Elimina traccia</button></div>`;
    bindPanel(m, k => {
      if (k === 'in') m.in = Math.min(m.in, m.out - 0.5);
      if (k === 'out') m.out = Math.max(m.out, m.in + 0.5);
      m.in = clamp(m.in, 0, m.srcDuration); m.out = clamp(m.out, 0, m.srcDuration);
      refresh();
    });
    return;
  }

  const c = item;
  const idx = clips.indexOf(c);
  const common = `
    ${idx > 0
      ? rangeField('Dissolvenza dalla clip precedente', 'transition', c.transition, 0, 3, 0.1)
      : '<p class="muted" style="font-size:12px">Prima clip: l\'inizio da nero si regola in ⚙ Progetto.</p>'}
    ${selectField('Adattamento allo schermo', 'fit', { contain: 'Mostra intera (bordi neri se servono)', cover: 'Riempi lo schermo (taglia i bordi)' }, c.fit)}
  `;
  const nav = `
    <hr>
    <div class="btnrow">
      <button class="btn small" data-act="moveLeft" ${idx === 0 ? 'disabled' : ''}>◀ Sposta prima</button>
      <button class="btn small" data-act="moveRight" ${idx === clips.length - 1 ? 'disabled' : ''}>Sposta dopo ▶</button>
      <button class="btn small" data-act="duplicate">⧉ Duplica</button>
    </div>
    <div class="btnrow"><button class="btn danger" data-act="remove">🗑 Elimina dal video</button></div>`;

  if (c.type === 'image') {
    const animOpts = Object.fromEntries(Object.entries(ANIMATIONS).map(([k, a]) => [k, a.label]));
    panel.innerHTML = `
      <img class="thumb" src="${c.thumb}" alt="">
      <h3>🖼 Foto</h3>
      <div class="sub">${esc(c.name)} · ${c.w}×${c.h}</div>
      ${rangeField('Durata sullo schermo', 'duration', c.duration, 0.5, 30, 0.1)}
      ${selectField('Animazione (movimento)', 'anim', animOpts, c.anim)}
      ${common}
      <div class="section-title">Applica a tutte le foto</div>
      <div class="btnrow">
        <button class="btn small" data-act="allDuration">Stessa durata</button>
        <button class="btn small" data-act="allAnim">Stessa animazione</button>
        <button class="btn small" data-act="allRandom">Animazioni casuali</button>
        <button class="btn small" data-act="allTransition">Stessa dissolvenza</button>
      </div>
      ${nav}`;
  } else {
    panel.innerHTML = `
      <img class="thumb" src="${c.thumb}" alt="">
      <h3>🎞 Video</h3>
      <div class="sub">${esc(c.name)} · ${c.w}×${c.h} · ${fmtTime(c.srcDuration)}</div>
      <div class="section-title">Taglio</div>
      ${rangeField('Inizio', 'in', c.in, 0, c.srcDuration, 0.05, 't')}
      ${rangeField('Fine', 'out', c.out, 0, c.srcDuration, 0.05, 't')}
      <div class="btnrow">
        <button class="btn small" data-act="setIn">⇤ Inizio al cursore</button>
        <button class="btn small" data-act="setOut">Fine al cursore ⇥</button>
        <button class="btn small" data-act="split">✂ Dividi al cursore</button>
      </div>
      <p class="muted" style="font-size:12px">Durata nel video: <b id="vidLen">${(c.out - c.in).toFixed(1)} s</b></p>
      <div class="section-title">Audio</div>
      ${checkField('Rimuovi audio del video (muto)', 'muted', c.muted)}
      ${rangeField('Volume', 'volume', c.volume, 0, 1.5, 0.01, '%')}
      <div class="section-title">Aspetto</div>
      ${common}
      ${nav}`;
  }

  bindPanel(c, k => {
    if (c.type === 'video') {
      if (k === 'in') c.in = clamp(Math.min(c.in, c.out - 0.2), 0, c.srcDuration);
      if (k === 'out') c.out = clamp(Math.max(c.out, c.in + 0.2), 0, c.srcDuration);
      const len = $('#vidLen'); if (len) len.textContent = `${(c.out - c.in).toFixed(1)} s`;
      const vol = panel.querySelector('[data-k=volume]'); if (vol) vol.disabled = c.muted;
    }
    refresh();
    const L = clipLayout(c);
    if (!L || player.playing) return;
    if (k === 'in' || k === 'duration' || k === 'anim' || k === 'transition') seek(L.start + (k === 'anim' ? 0 : Math.min(L.tr, L.dur)));
    if (k === 'out') seek(L.start + L.dur - 0.04);
  });
  if (c.type === 'video') panel.querySelector('[data-k=volume]').disabled = c.muted;
}

function buildProjectPanel() {
  const animOpts = { random: 'Casuale', ...Object.fromEntries(Object.entries(ANIMATIONS).map(([k, a]) => [k, a.label])) };
  const nPhotos = clips.filter(c => c.type === 'image').length;
  const nVideos = clips.length - nPhotos;
  panel.innerHTML = `
    <h3>⚙ Impostazioni progetto</h3>
    <div class="sub">${nPhotos} foto · ${nVideos} video · ${music.length} tracce musicali · durata ${fmtTime(total)}</div>
    ${selectField('Formato', 'aspect', { '16:9': 'Orizzontale 16:9 (YouTube, TV)', '9:16': 'Verticale 9:16 (Storie, Reels, TikTok)', '1:1': 'Quadrato 1:1', '4:3': 'Classico 4:3' }, settings.aspect)}
    ${selectField('Risoluzione', 'quality', { 480: '480p (leggero)', 720: '720p HD', 1080: '1080p Full HD' }, settings.quality)}
    ${selectField('Fotogrammi al secondo', 'fps', { 25: '25', 30: '30', 60: '60' }, settings.fps)}
    <div class="section-title">Dissolvenze</div>
    ${checkField("Inizia con dissolvenza dal nero", 'fadeFromBlack', settings.fadeFromBlack)}
    ${checkField('Termina con dissolvenza verso il nero', 'fadeToBlack', settings.fadeToBlack)}
    <div class="section-title">Movimento delle foto</div>
    ${rangeField('Intensità del movimento', 'animStrength', settings.animStrength, 0.25, 2.5, 0.05, 'x')}
    <p class="muted" style="font-size:12px;margin-top:-6px">1× = leggero (consigliato). Più basso = quasi fermo.</p>
    ${checkField('Movimento morbido (parte e si ferma dolcemente)', 'smoothAnim', settings.smoothAnim)}
    <div class="btnrow"><button class="btn small" data-act="allContain">Mostra tutte le foto intere</button></div>
    <div class="section-title">Valori predefiniti per le nuove foto</div>
    ${rangeField('Durata foto', 'photoDuration', settings.photoDuration, 0.5, 30, 0.1)}
    ${rangeField('Dissolvenza tra le clip', 'transition', settings.transition, 0, 3, 0.1)}
    ${selectField('Animazione', 'defaultAnim', animOpts, settings.defaultAnim)}
    <div class="btnrow">
      <button class="btn small" data-act="applyDefaultsAll">Applica a tutte le clip</button>
    </div>
    <hr>
    <p class="empty-hint">Suggerimento: clicca una clip nella timeline per modificarla.
      Scorciatoie: <b>spazio</b> = play/pausa, <b>Canc</b> = elimina la clip selezionata,
      <b>← →</b> = sposta il cursore.</p>`;
  bindPanel(settings, k => {
    if (k === 'aspect' || k === 'quality') applyCanvasSize();
    requestRender();
  });
}

/* =========================================================
 * Azioni dei pulsanti
 * ======================================================= */
function cursorLocal(c) {
  const L = clipLayout(c);
  if (!L || player.t < L.start || player.t > L.start + L.dur) return null;
  return c.in + (player.t - L.start);
}

const actions = {
  remove() {
    const item = selectedItem();
    if (!item) return;
    if (selected.kind === 'clip') clips.splice(clips.indexOf(item), 1);
    else music.splice(music.indexOf(item), 1);
    disposeMedia(item);
    selected = null;
    refresh();
    buildPanel();
  },
  moveLeft() { move(-1); },
  moveRight() { move(1); },
  async duplicate() {
    const c = selectedItem();
    const n = await cloneClip(c);
    clips.splice(clips.indexOf(c) + 1, 0, n);
    refresh();
    select({ kind: 'clip', id: n.id });
  },
  setIn() {
    const c = selectedItem(); const l = cursorLocal(c);
    if (l == null) return toast('Porta il cursore rosso sopra questa clip');
    if (l >= c.out - 0.2) return toast("L'inizio deve essere prima della fine");
    const L = clipLayout(c);
    c.in = l; refresh(); buildPanel(); seek(L.start);
  },
  setOut() {
    const c = selectedItem(); const l = cursorLocal(c);
    if (l == null) return toast('Porta il cursore rosso sopra questa clip');
    if (l <= c.in + 0.2) return toast('La fine deve essere dopo l\'inizio');
    c.out = l; refresh(); buildPanel();
  },
  async split() {
    const c = selectedItem(); const l = cursorLocal(c);
    if (l == null) return toast('Porta il cursore rosso sopra questa clip');
    if (l <= c.in + 0.2 || l >= c.out - 0.2) return toast('Cursore troppo vicino al bordo della clip');
    const n = await cloneClip(c);
    c.out = l; n.in = l; n.transition = 0;
    clips.splice(clips.indexOf(c) + 1, 0, n);
    refresh();
    select({ kind: 'clip', id: n.id });
    toast('Clip divisa in due: ora puoi eliminare o spostare una parte');
  },
  allDuration() { const c = selectedItem(); clips.forEach(x => { if (x.type === 'image') x.duration = c.duration; }); refresh(); toast('Durata applicata a tutte le foto'); },
  allAnim() { const c = selectedItem(); clips.forEach(x => { if (x.type === 'image') x.anim = c.anim; }); refresh(); toast('Animazione applicata a tutte le foto'); },
  allRandom() { clips.forEach(x => { if (x.type === 'image') x.anim = randomAnim(); }); refresh(); buildPanel(); toast('Animazioni casuali assegnate'); },
  allTransition() { const c = selectedItem(); clips.forEach(x => { x.transition = c.transition; }); refresh(); toast('Dissolvenza applicata a tutte le clip'); },
  applyDefaultsAll() {
    clips.forEach(x => {
      x.transition = settings.transition;
      if (x.type === 'image') {
        x.duration = settings.photoDuration;
        x.anim = settings.defaultAnim === 'random' ? randomAnim() : settings.defaultAnim;
      }
    });
    refresh(); buildPanel(); toast('Impostazioni applicate a tutte le clip');
  },
  allContain() { clips.forEach(x => { if (x.type === 'image') x.fit = 'contain'; }); refresh(); toast('Tutte le foto ora sono mostrate intere'); },
  musicToStart() { const m = selectedItem(); m.start = 0; refresh(); buildPanel(); },
  musicToCursor() { const m = selectedItem(); m.start = Math.round(player.t * 10) / 10; refresh(); buildPanel(); },
};

function move(dir) {
  const c = selectedItem();
  const i = clips.indexOf(c), j = i + dir;
  if (j < 0 || j >= clips.length) return;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  refresh();
  buildPanel();
}

/* =========================================================
 * Esportazione
 * ======================================================= */
const exp = { mode: 'fast', running: false, rec: null, chunks: [], canceled: false, mime: '', url: null };

const FORMATS = [
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'MP4 (H.264 + AAC) – consigliato', 'mp4'],
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'MP4 (H.264 + AAC)', 'mp4'],
  ['video/mp4;codecs=avc1,mp4a.40.2', 'MP4 (H.264 + AAC)', 'mp4'],
  ['video/mp4', 'MP4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'WebM (VP9 + Opus)', 'webm'],
  ['video/webm;codecs=vp8,opus', 'WebM (VP8 + Opus)', 'webm'],
  ['video/webm', 'WebM', 'webm'],
];
function supportedFormats() {
  if (!window.MediaRecorder) return [];
  const seen = new Set();
  return FORMATS.filter(([m, label]) => {
    if (!MediaRecorder.isTypeSupported(m) || seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

function openExport() {
  if (!clips.length) return toast('Il progetto è vuoto: aggiungi foto o video');
  if (loadingCount > 0) return toast('Attendi la fine del caricamento dei file');
  pause();
  const fmts = supportedFormats();
  const fast = fastSupported();
  if (!fmts.length && !fast) return toast('Questo browser non supporta l\'esportazione video. Usa Chrome o Edge aggiornati.', 6000);
  $('#expFormat').innerHTML = fmts.map(([m, l]) => `<option value="${m}">${esc(l)}</option>`).join('');
  const modeSel = $('#expMode');
  modeSel.querySelector('[value=fast]').disabled = !fast;
  modeSel.querySelector('[value=realtime]').disabled = !fmts.length;
  modeSel.value = fast ? 'fast' : 'realtime';
  updateExportMode();
  $('#expInfo').textContent = `Risoluzione ${canvas.width}×${canvas.height} · ${settings.fps} fps · durata ${fmtTime(total)}`;
  showExportStep('setup');
  $('#exportDlg').showModal();
}
function updateExportMode() {
  const rt = $('#expMode').value === 'realtime';
  $('#expFormatField').hidden = !rt;
  $('#expNoteRT').hidden = !rt;
  $('#expNoteFast').hidden = rt;
}
function showExportStep(step) {
  $('#exportSetup').hidden = step !== 'setup';
  $('#exportRun').hidden = step !== 'run';
  $('#exportDone').hidden = step !== 'done';
}

async function waitVideosReady(t) {
  const deadline = performance.now() + 5000;
  for (const [i, L] of layout.entries()) {
    if (L.clip.type !== 'video' || !isActive(L, i, t)) continue;
    const v = L.clip.el;
    while ((v.seeking || v.readyState < 2) && performance.now() < deadline) await sleep(30);
  }
}

function startExport() {
  exp.mode = $('#expMode').value;
  return exp.mode === 'fast' ? fastExport() : realtimeExport();
}

function exportFileName(ext) {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return `video_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
}

function deliverFile(blob, ext, extra = '') {
  if (exp.url) URL.revokeObjectURL(exp.url);
  exp.url = URL.createObjectURL(blob);
  const name = exportFileName(ext);
  const a = $('#expDownload');
  a.href = exp.url;
  a.download = name;
  $('#expResult').textContent = `${name} · ${(blob.size / 1048576).toFixed(1)} MB${extra}`;
  showExportStep('done');
  a.click(); // download automatico
}

async function realtimeExport() {
  ensureAudio();
  await actx.resume();
  exp.mime = $('#expFormat').value;
  exp.canceled = false;
  exp.chunks = [];
  showExportStep('run');
  $('#expProgress').value = 0;
  $('#expStatus').textContent = 'Preparazione…';
  select(null);

  seek(0);
  await waitVideosReady(0);
  render();
  await sleep(300);

  const vTrack = canvas.captureStream(settings.fps).getVideoTracks();
  const aTrack = exportDest.stream.getAudioTracks();
  const stream = new MediaStream([...vTrack, ...aTrack]);
  let rec;
  try {
    rec = new MediaRecorder(stream, {
      mimeType: exp.mime,
      videoBitsPerSecond: Number($('#expBitrate').value),
      audioBitsPerSecond: 192000,
    });
  } catch (err) {
    console.error(err);
    toast('Impossibile avviare la registrazione: ' + err.message, 6000);
    $('#exportDlg').close();
    return;
  }
  exp.rec = rec;
  rec.ondataavailable = e => { if (e.data && e.data.size) exp.chunks.push(e.data); };
  rec.onstop = () => {
    stream.getVideoTracks().forEach(t => t.stop());
    exp.running = false;
    if (exp.canceled) return;
    const ext = FORMATS.find(f => f[0] === exp.mime)?.[2] || 'webm';
    deliverFile(new Blob(exp.chunks, { type: exp.mime.split(';')[0] }), ext);
  };
  exp.running = true;
  rec.start(1000);
  play();
}

async function finishExport() {
  await sleep(250); // ultimo fotogramma
  if (exp.rec && exp.rec.state !== 'inactive') exp.rec.stop();
}

/* ---------------------------------------------------------
 * Esportazione veloce: i fotogrammi vengono calcolati uno per
 * uno e codificati con WebCodecs, l'audio è mixato "offline".
 * Non serve aspettare la durata reale del video.
 * ------------------------------------------------------- */
const AUDIO_RATE = 48000;
const fastSupported = () =>
  'VideoEncoder' in window && 'VideoFrame' in window && 'OfflineAudioContext' in window && !!window.Mp4Muxer;

async function pickVideoConfig(W, H, fps, bitrate) {
  const codecs = ['avc1.640034', 'avc1.64002A', 'avc1.640028', 'avc1.4D0034', 'avc1.4D0028', 'avc1.42003E', 'avc1.42001F'];
  for (const codec of codecs) {
    const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* prova il prossimo */ }
  }
  return null;
}

async function pickAudioConfig() {
  if (!('AudioEncoder' in window)) return null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 192000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch { /* prova il prossimo */ }
  }
  return null;
}

const audioCache = new Map(); // url -> AudioBuffer | null
async function decodeAudio(url) {
  if (audioCache.has(url)) return audioCache.get(url);
  let buf = null;
  try {
    const data = await (await fetch(url)).arrayBuffer();
    const dc = new OfflineAudioContext(2, 1, AUDIO_RATE);
    buf = await dc.decodeAudioData(data);
  } catch { buf = null; } // video senza audio
  audioCache.set(url, buf);
  return buf;
}

// Crea la colonna sonora completa (audio dei video + musica + dissolvenze)
async function renderAudioMix() {
  const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * AUDIO_RATE)), AUDIO_RATE);
  const mst = oc.createGain();
  mst.connect(oc.destination);
  const fl = Math.min(1, total / 4);
  mst.gain.setValueAtTime(settings.fadeFromBlack ? 0 : 1, 0);
  if (settings.fadeFromBlack) mst.gain.linearRampToValueAtTime(1, fl);
  if (settings.fadeToBlack) { mst.gain.setValueAtTime(1, total - fl); mst.gain.linearRampToValueAtTime(0, total); }

  for (const [i, L] of layout.entries()) {
    const c = L.clip;
    if (c.type !== 'video' || c.muted || c.volume <= 0) continue;
    const buf = await decodeAudio(c.url);
    if (!buf) continue;
    const src = oc.createBufferSource();
    src.buffer = buf;
    const gn = oc.createGain();
    src.connect(gn).connect(mst);
    const v = c.volume, a = L.start, b = L.start + L.dur, next = layout[i + 1];
    gn.gain.setValueAtTime(L.tr > 0 ? 0 : v, a);
    if (L.tr > 0) gn.gain.linearRampToValueAtTime(v, a + L.tr);
    if (next && next.tr > 0) { gn.gain.setValueAtTime(v, next.start); gn.gain.linearRampToValueAtTime(0, b); }
    src.start(a, c.in, L.dur);
  }

  for (const m of music) {
    const len = musicLen(m);
    if (len <= 0) continue;
    const buf = await decodeAudio(m.url);
    if (!buf) continue;
    const src = oc.createBufferSource();
    src.buffer = buf;
    const gn = oc.createGain();
    src.connect(gn).connect(mst);
    const v = m.volume, a = m.start, b = m.start + len;
    const fi = Math.min(m.fadeIn, len), fo = Math.min(m.fadeOut, len);
    gn.gain.setValueAtTime(fi > 0 ? 0 : v, a);
    if (fi > 0) gn.gain.linearRampToValueAtTime(v, a + fi);
    if (fo > 0) { gn.gain.setValueAtTime(v, Math.max(a + fi, b - fo)); gn.gain.linearRampToValueAtTime(0, b); }
    src.start(a, m.in, len);
  }
  return oc.startRendering();
}

function encodeAudioBuffer(buffer, encoder) {
  const N = buffer.length, CH = 4096;
  const L = buffer.getChannelData(0), R = buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0);
  for (let off = 0; off < N; off += CH) {
    const n = Math.min(CH, N - off);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(off, off + n), 0);
    data.set(R.subarray(off, off + n), n);
    const ad = new AudioData({
      format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfFrames: n,
      numberOfChannels: 2, timestamp: Math.round(off / buffer.sampleRate * 1e6), data,
    });
    encoder.encode(ad);
    ad.close();
  }
}

function seekExact(v, t) {
  return new Promise(resolve => {
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); resolve(); };
    v.addEventListener('seeked', fin);
    v.currentTime = t;
    setTimeout(fin, 5000);
  });
}

/* ---------------------------------------------------------
 * Lettura veloce dei fotogrammi dei video (MP4/MOV) con
 * WebCodecs: il file viene decodificato in sequenza invece
 * di "saltare" a ogni fotogramma con il lettore video.
 * ------------------------------------------------------- */
const exportFrames = new Map(); // clip.id -> { frame, rot }

// Legge solo le parti del file che descrivono il contenuto (tutto tranne 'mdat')
async function readMp4Info(blob) {
  if (!window.MP4Box) return null;
  const file = MP4Box.createFile(false);
  let info = null, error = null;
  file.onReady = i => { info = i; };
  file.onError = e => { error = e; };
  let pos = 0;
  while (pos + 8 <= blob.size && !info && !error) {
    const head = new DataView(await blob.slice(pos, pos + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = blob.size - pos;
    if (size < 8) break;
    // del blocco dati 'mdat' basta l'intestazione: il parser lo salta
    const len = type === 'mdat' ? (head.getUint32(0) === 1 ? 16 : 8) : size;
    if (len > 200 * 1048576) return null; // struttura anomala
    const buf = await blob.slice(pos, pos + len).arrayBuffer();
    buf.fileStart = pos;
    file.appendBuffer(buf);
    pos += size;
  }
  file.flush();
  if (!info) return null;
  return { file, info };
}

function codecDescription(file, trackId) {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // senza l'intestazione del box
    }
  }
  return undefined;
}

class VideoFrameReader {
  static async open(clip) {
    if (!('VideoDecoder' in window)) return null;
    try {
      const blob = await (await fetch(clip.url)).blob();
      const parsed = await readMp4Info(blob);
      if (!parsed) return null;
      const track = parsed.info.videoTracks[0];
      if (!track) return null;
      const config = {
        codec: track.codec,
        codedWidth: track.video.width,
        codedHeight: track.video.height,
        description: codecDescription(parsed.file, track.id),
      };
      const sup = await VideoDecoder.isConfigSupported(config);
      if (!sup.supported) return null;
      const samples = parsed.file.getTrackSamplesInfo(track.id);
      if (!samples || !samples.length) return null;
      const m = track.matrix || [65536, 0, 0, 0, 65536, 0, 0, 0, 0x40000000];
      const rot = ((Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI / 90) * 90) % 360 + 360) % 360;
      return new VideoFrameReader(clip, blob, samples, config, rot);
    } catch (err) {
      console.warn('Lettura veloce non disponibile per', clip.name, err);
      return null;
    }
  }

  constructor(clip, blob, samples, config, rot) {
    this.blob = blob;
    this.rot = rot;
    this.frames = [];
    this.ended = false;
    this.error = null;
    const minCts = Math.min(...samples.slice(0, 64).map(s => s.cts));
    this.samples = samples.map(s => ({
      offset: s.offset, size: s.size, key: s.is_sync,
      t: (s.cts - minCts) / s.timescale,
      dur: s.duration / s.timescale,
    }));
    // parte dall'ultimo fotogramma chiave prima del punto di inizio
    let start = 0;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].key && this.samples[i].t <= clip.in + 1e-3) start = i;
    }
    this.next = start;
    this.limit = clip.out + 1;
    this.decoder = new VideoDecoder({
      output: f => { this.frames.push(f); this.frames.sort((a, b) => a.timestamp - b.timestamp); },
      error: e => { this.error = e; },
    });
    this.decoder.configure(config);
  }

  async feed() {
    const batch = [];
    while (batch.length < 10 && this.next < this.samples.length) {
      const s = this.samples[this.next];
      if (s.t > this.limit && s.key) break;
      batch.push(s);
      this.next++;
    }
    if (!batch.length) {
      if (!this.ended) { await this.decoder.flush(); this.ended = true; }
      return;
    }
    const datas = await Promise.all(batch.map(s => this.blob.slice(s.offset, s.offset + s.size).arrayBuffer()));
    batch.forEach((s, i) => this.decoder.decode(new EncodedVideoChunk({
      type: s.key ? 'key' : 'delta',
      timestamp: Math.round(s.t * 1e6),
      duration: Math.round(s.dur * 1e6),
      data: datas[i],
    })));
    while (this.decoder.decodeQueueSize > 2 && !this.error) await sleep(1);
  }

  // Restituisce il fotogramma visibile al tempo t (secondi del file originale)
  async frameAt(t) {
    const tus = t * 1e6 + 500;
    let guard = 0;
    while (!this.ended) {
      if (this.error) throw this.error;
      const last = this.frames[this.frames.length - 1];
      if (last && last.timestamp > tus) break;
      // tiene in memoria pochi fotogrammi: libera quelli già superati
      while (this.frames.length > 1 && this.frames[1].timestamp <= tus) this.frames.shift().close();
      await this.feed();
      if (++guard > 100000) break;
    }
    while (this.frames.length > 1 && this.frames[1].timestamp <= tus) this.frames.shift().close();
    return this.frames[0] || null;
  }

  close() {
    for (const f of this.frames) f.close();
    this.frames = [];
    try { if (this.decoder.state !== 'closed') this.decoder.close(); } catch { /* ignore */ }
  }
}

const frameReaders = new Map(); // clip.id -> VideoFrameReader | null (null = usa il lettore video)
const finishedReaders = new Set();

async function prepareFramesAt(t) {
  const seeks = [];
  for (const [i, L] of layout.entries()) {
    const c = L.clip;
    if (c.type !== 'video') continue;
    if (!isActive(L, i, t)) {
      if (t > L.start + L.dur && frameReaders.get(c.id)) {
        frameReaders.get(c.id).close();
        frameReaders.set(c.id, null);
        finishedReaders.add(c.id);
        exportFrames.delete(c.id);
      }
      continue;
    }
    const local = Math.min(c.in + clamp(t - L.start, 0, L.dur), c.srcDuration - 0.001);
    if (!frameReaders.has(c.id) && !finishedReaders.has(c.id)) frameReaders.set(c.id, await VideoFrameReader.open(c));
    const reader = frameReaders.get(c.id);
    if (reader) {
      const frame = await reader.frameAt(local);
      exportFrames.set(c.id, { frame, rot: reader.rot });
      if (frame) continue;
      exportFrames.delete(c.id);
    }
    // metodo di riserva: posiziona il lettore video
    const v = c.el;
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - local) < 1e-4 && !v.seeking && v.readyState >= 2) continue;
    seeks.push(seekExact(v, local));
  }
  await Promise.all(seeks);
}

function closeFrameReaders() {
  for (const r of frameReaders.values()) if (r) r.close();
  frameReaders.clear();
  finishedReaders.clear();
  exportFrames.clear();
}

// Cede il controllo al browser senza i rallentamenti di setTimeout
const yieldUI = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

async function fastExport() {
  const status = txt => { $('#expStatus').textContent = txt; };
  exp.canceled = false;
  exp.running = true;
  showExportStep('run');
  $('#expProgress').value = 0;
  stopPlayback();
  select(null);

  const W = canvas.width, H = canvas.height, fps = settings.fps;
  let venc = null, aenc = null;
  try {
    status('Preparazione…');
    const vcfg = await pickVideoConfig(W, H, fps, Number($('#expBitrate').value));
    if (!vcfg) throw new Error('il browser non sa codificare video H.264');
    const acfg = await pickAudioConfig();

    status('Preparazione audio…');
    const hasAudio = music.length > 0 || clips.some(c => c.type === 'video' && !c.muted);
    const mix = acfg && hasAudio ? await renderAudioMix() : null;
    if (exp.canceled) throw new Error('canceled');

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H, frameRate: fps },
      audio: mix ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: AUDIO_RATE } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let encErr = null;
    venc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: e => { encErr = e; } });
    venc.configure(vcfg);
    if (mix) {
      aenc = new AudioEncoder({ output: (ch, meta) => muxer.addAudioChunk(ch, meta), error: e => { encErr = e; } });
      aenc.configure(acfg.cfg);
      encodeAudioBuffer(mix, aenc);
    }

    const N = Math.max(1, Math.round(total * fps));
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      if (exp.canceled) throw new Error('canceled');
      if (encErr) throw encErr;
      player.t = Math.min(i / fps, total);
      await prepareFramesAt(player.t);
      render();
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 6) await sleep(1);
      if (i % 5 === 0) {
        const done = (i + 1) / N;
        const elapsed = (performance.now() - t0) / 1000;
        const speed = elapsed > 0.5 ? ` · ${((i + 1) / fps / elapsed).toFixed(1)}× più veloce del tempo reale` : '';
        $('#expProgress').value = done;
        status(`Creazione video… ${Math.round(done * 100)}%${speed}`);
        await yieldUI();
      }
    }
    status('Finalizzazione…');
    await venc.flush();
    if (aenc) await aenc.flush();
    if (encErr) throw encErr;
    muxer.finalize();
    const secs = (performance.now() - t0) / 1000;
    exp.running = false;
    deliverFile(new Blob([muxer.target.buffer], { type: 'video/mp4' }), 'mp4', ` · creato in ${secs.toFixed(0)} s`);
  } catch (err) {
    exp.running = false;
    if (err.message === 'canceled') {
      $('#exportDlg').close();
      toast('Esportazione interrotta');
    } else {
      console.error(err);
      $('#exportDlg').close();
      toast(`Esportazione veloce non riuscita (${err.message}). Prova la modalità "In tempo reale".`, 8000);
    }
  } finally {
    try { if (venc && venc.state !== 'closed') venc.close(); } catch { /* ignore */ }
    try { if (aenc && aenc.state !== 'closed') aenc.close(); } catch { /* ignore */ }
    closeFrameReaders();
    seek(0);
  }
}

function abortExport() {
  exp.canceled = true;
  if (exp.mode === 'fast') { $('#expStatus').textContent = 'Interruzione…'; return; }
  exp.running = false;
  pause();
  if (exp.rec && exp.rec.state !== 'inactive') exp.rec.stop();
  $('#exportDlg').close();
  toast('Esportazione interrotta');
}

/* =========================================================
 * Collegamento interfaccia
 * ======================================================= */
function setupUI() {
  $('#btnAddMedia').onclick = () => $('#fileMedia').click();
  $('#btnAddMusic').onclick = () => $('#fileMusic').click();
  $('#fileMedia').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#fileMusic').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#btnProject').onclick = () => select(null);
  $('#btnExport').onclick = openExport;
  $('#btnPlay').onclick = togglePlay;
  $('#btnStart').onclick = () => seek(0);

  const sb = $('#seekBar');
  sb.addEventListener('input', () => { seekDragging = true; seek(sb.value / 1000 * total); });
  sb.addEventListener('change', () => { seekDragging = false; });

  $('#zoom').addEventListener('input', e => {
    const sc = $('#tlScroll');
    const centerT = (sc.scrollLeft + sc.clientWidth / 2) / pps;
    pps = Number(e.target.value);
    renderTimeline();
    sc.scrollLeft = centerT * pps - sc.clientWidth / 2;
  });

  // Esportazione
  $('#expStart').onclick = startExport;
  $('#expMode').onchange = updateExportMode;
  $('#expCancelSetup').onclick = () => $('#exportDlg').close();
  $('#expAbort').onclick = abortExport;
  $('#expClose').onclick = () => $('#exportDlg').close();
  $('#exportDlg').addEventListener('cancel', e => { if (exp.running) e.preventDefault(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && exp.running && exp.mode === 'realtime') {
      $('#expStatus').textContent = '⚠ Scheda nascosta: torna qui, altrimenti il video si blocca!';
    }
  });

  // Trascinamento file dal computer
  const overlay = $('#dropOverlay');
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; overlay.hidden = false; } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; overlay.hidden = true;
    addFiles(e.dataTransfer.files);
  });

  // Tastiera
  window.addEventListener('keydown', e => {
    if ($('#exportDlg').open) return;
    const tag = e.target.tagName;
    const typing = tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !['range', 'checkbox'].includes(e.target.type));
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); actions.remove(); }
    else if (e.key === 'ArrowLeft' && e.target.type !== 'range') { e.preventDefault(); seek(player.t - (e.shiftKey ? 1 : 0.1)); }
    else if (e.key === 'ArrowRight' && e.target.type !== 'range') { e.preventDefault(); seek(player.t + (e.shiftKey ? 1 : 0.1)); }
  });

  window.addEventListener('beforeunload', e => {
    if (clips.length || music.length) { e.preventDefault(); e.returnValue = ''; }
  });

  setupTimelineEvents();
}
let seekDragging = false;

setupUI();
applyCanvasSize();
relayout();
renderTimeline();
buildPanel();
render();

// Accesso per test automatici / console
window.editor = { clips, music, settings, player, seek, play, pause, addFiles, get total() { return total; }, exp };
