'use strict';

const $ = (id) => document.getElementById(id);

const island = $('island');
const compact = $('compact');
const cTitle = $('cTitle');
const xTitle = $('xTitle');
const xArtist = $('xArtist');
const fill = $('fill');
const tElapsed = $('tElapsed');
const tRemain = $('tRemain');
const progress = $('progress');

const DEMO = location.hash.startsWith('#demo');
const DEMO_EXPANDED = location.hash === '#demo-x' || location.hash === '#demo-q';
const DEMO_QUEUE = location.hash === '#demo-q';

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

let st = null;              // last media state from the sidecar
let expanded = false;
let panelOpen = false;      // queue drop-down visible
let panelCloseTimer = 0;
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

function applyMarquee() {
  xTitle.classList.remove('marquee');
  xTitle.style.removeProperty('--marquee-shift');
  const clip = xTitle.parentElement;
  const overflow = xTitle.scrollWidth - clip.clientWidth + 16;
  if (overflow > 8) {
    xTitle.style.setProperty('--marquee-shift', `-${overflow}px`);
    xTitle.style.setProperty('--marquee-dur', `${Math.max(6, overflow / 12)}s`);
    xTitle.classList.add('marquee');
  }
}

function render(prev) {
  const s = st;
  island.dataset.available = s && s.available ? 'true' : 'false';

  const playing = s && s.available &&
    (Date.now() < playMuteUntil ? island.dataset.playing === 'true' : s.playing);
  island.dataset.playing = playing ? 'true' : 'false';

  if (!s || !s.available) {
    cTitle.textContent = 'Not playing';
    xTitle.textContent = 'Not playing';
    xArtist.textContent = 'Open Spotify to get started';
    xTitle.classList.remove('marquee');
    setArt(null);
    updateTicker();
    return;
  }

  const trackChanged = !prev || prev.title !== s.title || prev.artist !== s.artist;
  if (trackChanged) {
    cTitle.textContent = s.artist ? `${s.title} — ${s.artist}` : s.title;
    xTitle.textContent = s.title || 'Unknown';
    xArtist.textContent = s.artist || '';
    requestAnimationFrame(applyMarquee);
    if (panelOpen && !DEMO) setTimeout(loadQueue, 600); // re-sync highlight on track change
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

let mode = 'dock'; // 'dock' | 'line' (ultra-minimized)

let lastExpandAt = 0;

function setExpanded(on) {
  if (on && mode === 'line') return;
  if (expanded === on) return;
  expanded = on;
  if (on) lastExpandAt = Date.now();
  island.dataset.state = on ? 'expanded' : 'collapsed';
  if (!on) closePanel();
  if (on) requestAnimationFrame(applyMarquee);
  updateTicker();
}

function setMode(m, save = true) {
  if (mode === m) return;
  mode = m;
  island.dataset.mode = m;
  if (m === 'line') { setExpanded(false); closePanel(); }
  if (save) window.native?.saveMode(m);
}

// Click the line to bring the dock back; middle-click the island to hide it.
island.addEventListener('click', () => {
  if (mode === 'line') {
    setMode('dock');
    setExpanded(true); // cursor is already on it
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

// Report live bounds to the main process for hit-testing. When the queue
// panel is open the hover zone is the union of island + gap + panel.
function sendZone() {
  const r = island.getBoundingClientRect();
  let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
  if (panelOpen) {
    const p = queuePanel.getBoundingClientRect();
    x1 = Math.min(x1, p.left);
    x2 = Math.max(x2, p.right);
    y2 = Math.max(y2, p.bottom);
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
$('bShuffle').addEventListener('click', () => {
  $('bShuffle').classList.toggle('on');
  cmd('shuffle');
});
$('bRepeat').addEventListener('click', () => cmd('repeat'));
$('bOpen').addEventListener('click', () => window.native?.openSpotify());
$('xArt').addEventListener('dblclick', () => window.native?.openSpotify());

// ------------------------------------------------------------------
// Queue drop-down
// ------------------------------------------------------------------

const handle = $('handle');
const queuePanel = $('queuePanel');
const qList = $('qList');
const qHeader = $('qHeader');
const qMsg = $('qMsg');
const qMsgText = $('qMsgText');
const bConnect = $('bConnect');

let queueView = null;    // last successful view (stale-while-revalidate)
let queueReqId = 0;

// The panel only stays open while the cursor is on the handle or the panel
// itself; moving back onto the main island (or away) closes it.
let panelOpenedAt = 0;

function openPanel() {
  clearTimeout(panelCloseTimer);
  if (panelOpen || !expanded || mode === 'line') return;
  panelOpen = true;
  panelOpenedAt = Date.now();
  document.body.dataset.panel = 'open';
  loadQueue();
  requestAnimationFrame(sendZone);
}

function closePanel() {
  clearTimeout(panelCloseTimer);
  if (!panelOpen) return;
  panelOpen = false;
  delete document.body.dataset.panel;
  requestAnimationFrame(sendZone);
}

function schedulePanelClose() {
  clearTimeout(panelCloseTimer);
  panelCloseTimer = setTimeout(closePanel, 220);
}

// Guard: while the island is still growing under a stationary cursor, the
// handle can slide beneath it and fire a phantom mouseenter — ignore those.
handle.addEventListener('mouseenter', () => {
  if (Date.now() - lastExpandAt < 500) return;
  openPanel();
});
handle.addEventListener('mouseleave', schedulePanelClose);
handle.addEventListener('click', () => (panelOpen ? closePanel() : openPanel()));
queuePanel.addEventListener('mouseenter', () => clearTimeout(panelCloseTimer));
queuePanel.addEventListener('mouseleave', schedulePanelClose);

function showQMsg(text, connect) {
  qMsg.hidden = false;
  qMsgText.textContent = text;
  bConnect.hidden = !connect;
  qList.style.visibility = 'hidden';
  qHeader.textContent = 'Queue';
}

function renderQueue(view) {
  qMsg.hidden = true;
  qList.style.visibility = 'visible';
  qHeader.textContent = view.name
    ? `${view.name} · ${view.tracks.length} songs`
    : `${view.tracks.length} songs`;

  // Stagger rows in only when the panel has just opened (not on refreshes).
  const stagger = Date.now() - panelOpenedAt < 450;
  const frag = document.createDocumentFragment();
  view.tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'qRow' + (i === view.currentIndex ? ' current' : '');
    if (stagger && i < 12) {
      row.style.animation = 'qIn 240ms var(--out) both';
      row.style.animationDelay = `${70 + i * 24}ms`;
    }
    const num = document.createElement('div');
    num.className = 'qNum';
    num.textContent = i === view.currentIndex ? '♪' : String(i + 1);
    const mid = document.createElement('div');
    mid.className = 'qMid';
    const title = document.createElement('div');
    title.className = 'qTitle';
    title.textContent = t.title;
    const artist = document.createElement('div');
    artist.className = 'qArtist';
    artist.textContent = t.artist;
    mid.append(title, artist);
    const dur = document.createElement('div');
    dur.className = 'qDur';
    dur.textContent = t.durMs ? fmt(t.durMs) : '';
    row.append(num, mid, dur);
    row.addEventListener('click', () => jumpTo(view, i));
    frag.append(row);
  });
  qList.replaceChildren(frag);

  const scrollToCurrent = () => {
    const cur = qList.children[view.currentIndex];
    if (cur) qList.scrollTop = Math.max(0, cur.offsetTop - qList.clientHeight / 2 + cur.offsetHeight / 2);
  };
  // The island may still be mid-spring when this renders; wait for real height.
  if (qList.clientHeight > 80) scrollToCurrent();
  else setTimeout(scrollToCurrent, 540);
}

async function loadQueue() {
  if (DEMO) { renderQueue(demoQueue()); return; }
  if (queueView) renderQueue(queueView);
  else showQMsg('Loading…', false);

  const id = ++queueReqId;
  const r = await window.native?.getQueue();
  if (id !== queueReqId || !panelOpen) return;

  if (r?.ok) {
    queueView = r;
    renderQueue(r);
  } else if (!queueView) {
    const reasons = {
      'no-client-id': 'Queue needs a one-time Spotify setup — see the README.',
      'not-connected': 'Connect your Spotify account to see the queue.',
      'nothing-playing': 'Nothing playing right now.',
      'no-context': "This queue can't be read (radio or autoplay).",
      'premium': 'Spotify Premium is required for this.',
      'owner-premium': "Spotify blocks its API for free accounts — the Spotify account that owns the API app needs Premium. (Spotify's rule, not Ohm's.)",
    };
    showQMsg(reasons[r?.reason] || 'Queue unavailable right now.', r?.reason === 'not-connected');
  }
}

async function jumpTo(view, i) {
  const oldIndex = view.currentIndex;
  // optimistic highlight
  const prev = qList.querySelector('.qRow.current');
  if (prev) {
    prev.classList.remove('current');
    prev.querySelector('.qNum').textContent = String([...qList.children].indexOf(prev) + 1);
  }
  const row = qList.children[i];
  if (row) {
    row.classList.add('current');
    row.querySelector('.qNum').textContent = '♪';
  }
  if (view) view.currentIndex = i;

  const r = await window.native?.jump({
    contextUri: view.contextUri,
    position: i,
    currentIndex: oldIndex,
    shuffle: !!(st && st.shuffle),
  });
  if (!r?.ok) {
    qHeader.textContent = r?.reason === 'premium'
      ? 'Spotify Premium is needed to jump'
      : 'Could not jump to that song';
    setTimeout(() => { if (queueView) renderQueue(queueView); }, 2200);
  }
}

bConnect.addEventListener('click', async () => {
  showQMsg('Check your browser to approve…', false);
  const r = await window.native?.spotifyConnect();
  if (r?.ok) loadQueue();
  else if (r?.reason === 'no-client-id') showQMsg('Queue needs a one-time Spotify setup — see the README.', false);
  else showQMsg('Connection failed — try again from the right-click menu.', true);
});

window.native?.onSpotifyConnected(() => { if (panelOpen) loadQueue(); });

function demoQueue() {
  const names = ['Borderline', 'Breathe Deeper', 'Lost in Yesterday', 'Is It True', 'It Might Be Time', 'Glimmer', 'One More Hour', 'Instant Destiny'];
  return {
    name: 'The Slow Rush',
    contextUri: null,
    currentIndex: 0,
    tracks: names.map((n, i) => ({ i, id: String(i), title: n, artist: 'Tame Impala', durMs: 180000 + i * 21000 })),
  };
}

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
  if (DEMO_QUEUE) openPanel();
}
