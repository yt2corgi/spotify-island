'use strict';

const $ = (id) => document.getElementById(id);

const island = $('island');
const compact = $('compact');
const cTitle = $('cTitle');
const cTitleInner = $('cTitleInner');
const xTitle = $('xTitle');
const xArtist = $('xArtist');
const fill = $('fill');
const tElapsed = $('tElapsed');
const tRemain = $('tRemain');
const progress = $('progress');

const DEMO = location.hash.startsWith('#demo');
const DEMO_EXPANDED = location.hash === '#demo-x';

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

let st = null;              // last media state from the sidecar
let expanded = false;
let expandTimer = 0;
let collapseTimer = 0;
let tickTimer = 0;
let scrubbing = false;
let seekMuteUntil = 0;      // ignore stale positions right after a seek
let playMuteUntil = 0;      // ignore stale playing flag right after play/pause

// ------------------------------------------------------------------
// Album art (two stacked <img> per slot for crossfades)
// ------------------------------------------------------------------

function makeArtSlot(el) {
  const a = document.createElement('img');
  const b = document.createElement('img');
  el.append(a, b);
  let front = a;
  return (url) => {
    if (!url) { a.classList.remove('on'); b.classList.remove('on'); return; }
    const back = front === a ? b : a;
    back.onload = () => {
      back.classList.add('on');
      front.classList.remove('on');
      front = back;
    };
    back.src = url;
  };
}

const setCompactArt = makeArtSlot($('cArt'));
const setExpandedArt = makeArtSlot($('xArt'));

function setArt(url) {
  setCompactArt(url);
  setExpandedArt(url);
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------

function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function currentPos() {
  if (!st || !st.available) return 0;
  let p = st.positionMs + (st.playing ? Date.now() - st.ts : 0);
  if (st.durationMs > 0) p = Math.min(p, st.durationMs);
  return Math.max(0, p);
}

function renderTimeline() {
  if (!st || !st.available || scrubbing) return;
  const dur = st.durationMs;
  const pos = currentPos();
  fill.style.transform = `scaleX(${dur > 0 ? pos / dur : 0})`;
  tElapsed.textContent = fmt(pos);
  tRemain.textContent = dur > 0 ? '-' + fmt(dur - pos) : '0:00';
}

function updateTicker() {
  const need = expanded && st && st.available && st.playing && !scrubbing;
  if (need && !tickTimer) tickTimer = setInterval(renderTimeline, 250);
  if (!need && tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
}

// Continuous looping marquee: shift by one full copy + gap, with a
// duplicate (::after) trailing so the wrap is seamless.
const MARQUEE_GAP = 48;
const MARQUEE_SPEED = 30; // px per second

function setupLoop(el, clipEl, classEl, className) {
  classEl.classList.remove(className);
  el.removeAttribute('data-text');
  const w = el.scrollWidth; // single copy width (no ::after while class is off)
  if (w - clipEl.clientWidth > 6) {
    const shift = w + MARQUEE_GAP;
    el.dataset.text = el.textContent;
    el.style.setProperty('--marquee-shift', `-${shift}px`);
    el.style.setProperty('--marquee-dur', `${Math.max(6, shift / MARQUEE_SPEED)}s`);
    classEl.classList.add(className);
  }
}

function applyCompactMarquee() { setupLoop(cTitleInner, cTitle, cTitle, 'scrolling'); }
function applyMarquee() { setupLoop(xTitle, xTitle.parentElement, xTitle, 'marquee'); }

function render(prev) {
  const s = st;
  island.dataset.available = s && s.available ? 'true' : 'false';

  const playing = s && s.available &&
    (Date.now() < playMuteUntil ? island.dataset.playing === 'true' : s.playing);
  island.dataset.playing = playing ? 'true' : 'false';

  if (!s || !s.available) {
    cTitleInner.textContent = 'Not playing';
    cTitle.classList.remove('scrolling');
    xTitle.textContent = 'Not playing';
    xArtist.textContent = 'Open Spotify to get started';
    xTitle.classList.remove('marquee');
    setArt(null);
    updateTicker();
    return;
  }

  const trackChanged = !prev || prev.title !== s.title || prev.artist !== s.artist;
  if (trackChanged) {
    cTitleInner.textContent = s.artist ? `${s.title} — ${s.artist}` : s.title;
    xTitle.textContent = s.title || 'Unknown';
    xArtist.textContent = s.artist || '';
    requestAnimationFrame(() => { applyMarquee(); applyCompactMarquee(); });
  }

  $('bShuffle').classList.toggle('on', !!s.shuffle);
  const rep = (s.repeat || 'None').toLowerCase();
  $('bRepeat').classList.toggle('on', rep !== 'none');
  $('bRepeat').classList.toggle('one', rep === 'track');

  renderTimeline();
  updateTicker();
}

function onMedia(msg) {
  if (msg.type === 'art') {
    if (!msg.data) { setArt(null); return; }
    const mime = msg.data.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
    setArt(`data:${mime};base64,${msg.data}`);
    return;
  }
  if (msg.type !== 'state') return;
  const prev = st;
  if (Date.now() < seekMuteUntil && st && msg.available) {
    // keep our optimistic position, take everything else
    msg.positionMs = st.positionMs;
    msg.ts = st.ts;
  }
  st = msg;
  render(prev);
}

// ------------------------------------------------------------------
// Expand / collapse
// ------------------------------------------------------------------

let mode = 'dock'; // 'dock' | 'mini' (waveform-only pill) | 'line' (thin line)

function setExpanded(on) {
  if (on && mode === 'line') return;
  if (expanded === on) return;
  expanded = on;
  island.dataset.state = on ? 'expanded' : 'collapsed';
  if (on) requestAnimationFrame(applyMarquee);
  updateTicker();
}

function setMode(m, save = true) {
  if (mode === m) return;
  mode = m;
  island.dataset.mode = m;
  if (m === 'line') setExpanded(false);
  if (save) window.native?.saveMode(m);
}

// Gestures: click the line to bring the dock back; double-click toggles the
// waveform-only mini pill; triple-click hides to the line. Middle-click also
// toggles the line. (e.detail counts clicks in a burst.)
let gestureTimer = 0;

island.addEventListener('click', (e) => {
  if (e.target.closest('.btn, .progress, .openBtn')) return;
  if (mode === 'line') {
    setMode('dock');
    setExpanded(true); // cursor is already on it
    return;
  }
  if (e.detail === 2) {
    clearTimeout(gestureTimer);
    // wait a beat in case a third click turns this into the line gesture
    gestureTimer = setTimeout(() => setMode(mode === 'mini' ? 'dock' : 'mini'), 260);
  } else if (e.detail >= 3) {
    clearTimeout(gestureTimer);
    setMode('line');
  }
});

island.addEventListener('auxclick', (e) => {
  if (e.button === 1) setMode(mode === 'line' ? 'dock' : 'line');
});
window.native?.onMode((m) => setMode(m, false));

// Main process watches the cursor against our reported bounds and tells us
// when the pointer is over the island (DOM hover events can't be trusted
// through a click-through window).
function onHover(over) {
  if (over) {
    clearTimeout(collapseTimer);
    clearTimeout(expandTimer);
    setExpanded(true); // instant — the animation itself is the delay
  } else {
    clearTimeout(expandTimer);
    if (DEMO_EXPANDED) return;
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => setExpanded(false), 320);
  }
}
window.native?.onHover(onHover);

// Report the island's live bounds to the main process for hit-testing.
function sendZone() {
  const r = island.getBoundingClientRect();
  window.native?.zone({ x: r.x, y: r.y, w: r.width, h: r.height });
}
new ResizeObserver(sendZone).observe(island);
sendZone();

compact.addEventListener('click', () => {
  clearTimeout(expandTimer);
  setExpanded(true);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.native?.menu();
});

// ------------------------------------------------------------------
// Controls
// ------------------------------------------------------------------

function cmd(c) { window.native?.cmd(c); }

$('bPlay').addEventListener('click', () => {
  if (!st || !st.available) return;
  // optimistic flip so the icon responds instantly
  const now = island.dataset.playing === 'true';
  island.dataset.playing = now ? 'false' : 'true';
  playMuteUntil = Date.now() + 900;
  if (st) { st.positionMs = currentPos(); st.ts = Date.now(); st.playing = !now; }
  cmd('playpause');
  updateTicker();
});

$('bNext').addEventListener('click', () => cmd('next'));
$('bPrev').addEventListener('click', () => cmd('prev'));
$('bShuffle').addEventListener('click', () => {
  $('bShuffle').classList.toggle('on');
  cmd('shuffle');
});
$('bRepeat').addEventListener('click', () => cmd('repeat'));
$('bOpen').addEventListener('click', () => window.native?.openSpotify());
$('xArt').addEventListener('dblclick', () => window.native?.openSpotify());

// ------------------------------------------------------------------
// Scrubbing
// ------------------------------------------------------------------

function scrubPos(e) {
  const r = progress.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}

progress.addEventListener('pointerdown', (e) => {
  if (!st || !st.available || !st.durationMs) return;
  scrubbing = true;
  progress.classList.add('scrubbing');
  progress.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const p = scrubPos(ev);
    fill.style.transform = `scaleX(${p})`;
    tElapsed.textContent = fmt(p * st.durationMs);
    tRemain.textContent = '-' + fmt((1 - p) * st.durationMs);
  };
  move(e);
  const up = (ev) => {
    progress.removeEventListener('pointermove', move);
    progress.removeEventListener('pointerup', up);
    progress.classList.remove('scrubbing');
    scrubbing = false;
    const ms = Math.round(scrubPos(ev) * st.durationMs);
    st.positionMs = ms;
    st.ts = Date.now();
    seekMuteUntil = Date.now() + 1200;
    cmd(`seek ${ms}`);
    updateTicker();
  };
  progress.addEventListener('pointermove', move);
  progress.addEventListener('pointerup', up);
});

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------

if (!DEMO) window.native?.onMedia(onMedia);

if (DEMO) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 112;
  const g = cv.getContext('2d');
  g.fillStyle = '#3d4f5c';
  g.fillRect(0, 0, 112, 112);
  g.fillStyle = '#141a1f';
  g.beginPath(); g.arc(56, 56, 34, 0, 7); g.fill();
  g.fillStyle = '#c9a15f';
  g.beginPath(); g.arc(56, 56, 11, 0, 7); g.fill();
  setArt(cv.toDataURL());
  st = {
    type: 'state', available: true, title: 'Borderline', artist: 'Tame Impala',
    album: 'The Slow Rush', playing: true, positionMs: 83000, durationMs: 237000,
    shuffle: true, repeat: 'None', ts: Date.now(),
  };
  render(null);
  if (DEMO_EXPANDED) setExpanded(true);
}
