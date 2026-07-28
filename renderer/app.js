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
const volPill = $('volPill');
const volFill = $('volFill');

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
let shuffleMuteUntil = 0;   // keep the predicted shuffle state briefly
let shuffleSm = 'off';      // last known tri-state shuffle mode
let volMuteUntil = 0;       // keep the locally-set volume briefly
let curVol = 60;            // last known Spotify app volume (0-100)

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

// Continuous looping marquee: a duplicate copy (::after, separated by a
// dash) trails the first so the wrap is invisible.
const MARQUEE_SPEED = 30; // px per second

function setupLoop(el, clipEl, classEl, className) {
  classEl.classList.remove(className);
  el.removeAttribute('data-text');
  const w = el.scrollWidth; // single copy width (no ::after while class is off)
  if (w - clipEl.clientWidth > 6) {
    el.dataset.text = el.textContent;
    classEl.classList.add(className);
    const shift = el.scrollWidth - w; // one copy + separator, measured for real
    el.style.setProperty('--marquee-shift', `-${shift}px`);
    el.style.setProperty('--marquee-dur', `${Math.max(6, shift / MARQUEE_SPEED)}s`);
  }
}

function applyMarquee() { setupLoop(xTitle, xTitle.parentElement, xTitle, 'marquee'); }

// Compact title holds styled spans (white title, grey artist), so its loop
// duplicates real DOM nodes instead of using ::after text.
function compactPair(title, artist) {
  const frag = document.createDocumentFragment();
  const t = document.createElement('span');
  t.className = 'tt';
  t.textContent = title;
  frag.append(t);
  if (artist) {
    const a = document.createElement('span');
    a.className = 'ta';
    a.textContent = ` — ${artist}`;
    frag.append(a);
  }
  return frag;
}

function applyCompactMarquee() {
  cTitle.classList.remove('scrolling');
  cTitleInner.querySelectorAll('.clone').forEach((n) => n.remove());
  const w = cTitleInner.scrollWidth;
  if (w - cTitle.clientWidth > 6) {
    const sep = document.createElement('span');
    sep.className = 'ta clone';
    sep.textContent = '  —  ';
    const originals = [...cTitleInner.children];
    cTitleInner.append(sep);
    for (const n of originals) {
      const c = n.cloneNode(true);
      c.classList.add('clone');
      cTitleInner.append(c);
    }
    const shift = cTitleInner.scrollWidth - w;
    cTitleInner.style.setProperty('--marquee-shift', `-${shift}px`);
    cTitleInner.style.setProperty('--marquee-dur', `${Math.max(6, shift / MARQUEE_SPEED)}s`);
    cTitle.classList.add('scrolling');
  }
}

function render(prev) {
  const s = st;
  island.dataset.available = s && s.available ? 'true' : 'false';

  const playing = s && s.available &&
    (Date.now() < playMuteUntil ? island.dataset.playing === 'true' : s.playing);
  island.dataset.playing = playing ? 'true' : 'false';

  if (!s || !s.available) {
    cTitleInner.replaceChildren(document.createTextNode('Not playing'));
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
    cTitleInner.replaceChildren(compactPair(s.title, s.artist));
    xTitle.textContent = s.title || 'Unknown';
    xArtist.textContent = s.artist || '';
    requestAnimationFrame(() => { applyMarquee(); applyCompactMarquee(); });
  }

  // Tri-state shuffle: prefer the UIA-read mode (SMTC's bool reports FALSE
  // during smart shuffle, so it can't be trusted alone). Right after a click
  // we keep the optimistic prediction until the real state settles.
  if (Date.now() > shuffleMuteUntil) {
    const sm = s.shuffleMode && s.shuffleMode !== 'unknown'
      ? s.shuffleMode
      : (s.shuffle ? 'on' : 'off');
    shuffleSm = sm;
    applyShuffleUi(sm);
  }
  const rep = (s.repeat || 'None').toLowerCase();
  $('bRepeat').classList.toggle('on', rep !== 'none');
  $('bRepeat').classList.toggle('one', rep === 'track');

  if (typeof s.volume === 'number' && s.volume >= 0 && Date.now() > volMuteUntil) {
    curVol = s.volume;
    volFill.style.setProperty('--vol', curVol / 100);
  }

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
  document.body.dataset.expanded = on ? 'true' : 'false';
  if (on) requestAnimationFrame(applyMarquee);
  requestAnimationFrame(sendZone);
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

// Report live bounds to the main process for hit-testing. When expanded the
// zone also covers the volume pill beside the island.
function sendZone() {
  const r = island.getBoundingClientRect();
  let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
  if (expanded) {
    const v = volPill.getBoundingClientRect();
    x1 = Math.min(x1, v.left);
    x2 = Math.max(x2, v.right);
    y2 = Math.max(y2, v.bottom);
  }
  window.native?.zone({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
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
function applyShuffleUi(sm) {
  const b = $('bShuffle');
  b.classList.toggle('on', sm !== 'off');
  b.classList.toggle('smart', sm === 'smart');
}

// The cycle is deterministic (off -> on -> smart -> off), so flip the icon
// instantly to the predicted state; the sidecar's real state confirms it.
$('bShuffle').addEventListener('click', () => {
  shuffleSm = shuffleSm === 'off' ? 'on' : shuffleSm === 'on' ? 'smart' : 'off';
  shuffleMuteUntil = Date.now() + 1200;
  applyShuffleUi(shuffleSm);
  cmd('shuffle');
});
$('bRepeat').addEventListener('click', () => cmd('repeat'));
$('bOpen').addEventListener('click', () => window.native?.openSpotify());
$('xArt').addEventListener('dblclick', () => window.native?.openSpotify());

// ------------------------------------------------------------------
// Volume (Spotify app volume through the Windows mixer)
// ------------------------------------------------------------------

let lastVolSend = 0;

function setVolume(pct, send = true) {
  curVol = Math.max(0, Math.min(100, Math.round(pct)));
  volFill.style.setProperty('--vol', curVol / 100);
  volMuteUntil = Date.now() + 1500;
  if (send && Date.now() - lastVolSend > 60) {
    lastVolSend = Date.now();
    cmd(`vol ${curVol}`);
  }
}

volPill.addEventListener('pointerdown', (e) => {
  volPill.setPointerCapture(e.pointerId);
  window.native?.lock(true); // window must stay interactive for the whole drag
  const track = volPill.firstElementChild.getBoundingClientRect();
  const fromY = (ev) => (1 - (ev.clientY - track.top) / track.height) * 100;
  setVolume(fromY(e));
  const move = (ev) => setVolume(fromY(ev));
  const end = (ev) => {
    volPill.removeEventListener('pointermove', move);
    volPill.removeEventListener('pointerup', end);
    volPill.removeEventListener('pointercancel', end);
    window.native?.lock(false);
    lastVolSend = 0;
    setVolume(fromY(ev)); // final value always sent
  };
  volPill.addEventListener('pointermove', move);
  volPill.addEventListener('pointerup', end);
  volPill.addEventListener('pointercancel', end);
});

// Scroll wheel anywhere on the island or the pill nudges volume.
function onWheel(e) {
  if (!expanded) return;
  lastVolSend = 0;
  setVolume(curVol + (e.deltaY < 0 ? 5 : -5));
}
island.addEventListener('wheel', onWheel, { passive: true });
volPill.addEventListener('wheel', onWheel, { passive: true });

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
  window.native?.lock(true);
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
    window.native?.lock(false);
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
    shuffle: true, repeat: 'None', volume: 65, ts: Date.now(),
  };
  render(null);
  if (DEMO_EXPANDED) setExpanded(true);
}
