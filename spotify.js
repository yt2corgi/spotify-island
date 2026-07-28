'use strict';

// Spotify Web API client (PKCE, no client secret) for the queue dropdown.
// SMTC has no concept of a playlist/queue, so jumping to arbitrary tracks
// requires the Web API. Tokens live in userData/spotify-tokens.json.

const { shell } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REDIRECT_PORT = 8898;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ');

class Spotify {
  constructor(userDataDir, clientId) {
    this.clientId = clientId || '';
    this.tokFile = path.join(userDataDir, 'spotify-tokens.json');
    this.tok = null;
    this.cache = { uri: null, at: 0, view: null };
    try { this.tok = JSON.parse(fs.readFileSync(this.tokFile, 'utf8')); } catch {}
  }

  get configured() { return !!this.clientId; }
  get connected() { return !!(this.tok && this.tok.refresh_token); }

  saveTok(t) {
    this.tok = { ...t, saved_at: Date.now() };
    try { fs.writeFileSync(this.tokFile, JSON.stringify(this.tok)); } catch {}
  }

  // ---------------------------------------------------------------- auth

  async connect() {
    if (!this.configured) return { ok: false, reason: 'no-client-id' };

    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(12).toString('base64url');

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
        if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:95vh"><div>Spotify connected — you can close this tab.</div></body>');
        server.close();
        clearTimeout(timer);
        if (u.searchParams.get('state') !== state) reject(new Error('state mismatch'));
        else if (u.searchParams.get('error')) reject(new Error(u.searchParams.get('error')));
        else resolve(u.searchParams.get('code'));
      });
      server.on('error', reject);
      const timer = setTimeout(() => { server.close(); reject(new Error('timeout')); }, 180000);
      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        const auth = new URL('https://accounts.spotify.com/authorize');
        auth.search = new URLSearchParams({
          client_id: this.clientId,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          scope: SCOPES,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state,
        }).toString();
        shell.openExternal(auth.toString());
      });
    });

    const t = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: this.clientId,
      code_verifier: verifier,
    });
    this.saveTok(t);
    return { ok: true };
  }

  async tokenRequest(params) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async accessToken() {
    if (!this.connected) throw new Error('not connected');
    const age = (Date.now() - (this.tok.saved_at || 0)) / 1000;
    if (age > (this.tok.expires_in || 3600) - 120) {
      const t = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.tok.refresh_token,
        client_id: this.clientId,
      });
      if (!t.refresh_token) t.refresh_token = this.tok.refresh_token;
      this.saveTok(t);
    }
    return this.tok.access_token;
  }

  async api(method, url, body) {
    const token = await this.accessToken();
    const res = await fetch(`https://api.spotify.com/v1${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(json?.error?.message || `${res.status}`);
      err.status = res.status;
      err.reason = json?.error?.reason;
      throw err;
    }
    return json;
  }

  // ---------------------------------------------------------------- queue

  async getQueueView() {
    if (!this.configured) return { ok: false, reason: 'no-client-id' };
    if (!this.connected) return { ok: false, reason: 'not-connected' };

    const player = await this.api('GET', '/me/player');
    if (!player || !player.item) return { ok: false, reason: 'nothing-playing' };

    const currentId = player.item.id;
    const ctx = player.context; // may be null (radio/autoplay)

    if (ctx && (ctx.type === 'playlist' || ctx.type === 'album') ) {
      const view = await this.contextTracks(ctx);
      view.currentIndex = view.tracks.findIndex((t) => t.id === currentId);
      view.contextUri = ctx.uri;
      view.ok = true;
      return view;
    }

    if (ctx && ctx.uri && ctx.uri.endsWith(':collection')) {
      const view = await this.likedTracks(ctx.uri);
      view.currentIndex = view.tracks.findIndex((t) => t.id === currentId);
      view.ok = true;
      return view;
    }

    // No browsable context — fall back to the play queue (Premium).
    try {
      const q = await this.api('GET', '/me/player/queue');
      const tracks = [
        this.slim(player.item, 0),
        ...(q?.queue || []).slice(0, 40).map((t, i) => this.slim(t, i + 1)),
      ];
      return { ok: true, name: 'Up next', tracks, currentIndex: 0, contextUri: null };
    } catch (e) {
      return { ok: false, reason: 'no-context' };
    }
  }

  slim(t, i) {
    return {
      i,
      id: t.id,
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', '),
      durMs: t.duration_ms || 0,
    };
  }

  async contextTracks(ctx) {
    const now = Date.now();
    if (this.cache.uri === ctx.uri && now - this.cache.at < 120000) return { ...this.cache.view };

    const id = ctx.uri.split(':').pop();
    let name = '';
    const tracks = [];

    if (ctx.type === 'playlist') {
      const meta = await this.api('GET', `/playlists/${id}?fields=name`);
      name = meta?.name || 'Playlist';
      let url = `/playlists/${id}/tracks?limit=100&fields=items(track(id,name,duration_ms,artists(name))),next`;
      for (let page = 0; page < 3 && url; page++) {
        const r = await this.api('GET', url);
        for (const it of r.items || []) {
          if (it.track && it.track.id) tracks.push(this.slim(it.track, tracks.length));
        }
        url = r.next ? r.next.replace('https://api.spotify.com/v1', '') : null;
      }
    } else {
      const album = await this.api('GET', `/albums/${id}`);
      name = album?.name || 'Album';
      for (const t of album?.tracks?.items || []) tracks.push(this.slim(t, tracks.length));
    }

    const view = { name, tracks };
    this.cache = { uri: ctx.uri, at: now, view };
    return { ...view };
  }

  async likedTracks(uri) {
    const now = Date.now();
    if (this.cache.uri === uri && now - this.cache.at < 120000) return { ...this.cache.view };
    const tracks = [];
    let url = '/me/tracks?limit=50';
    for (let page = 0; page < 4 && url; page++) {
      const r = await this.api('GET', url);
      for (const it of r.items || []) {
        if (it.track && it.track.id) tracks.push(this.slim(it.track, tracks.length));
      }
      url = r.next ? r.next.replace('https://api.spotify.com/v1', '') : null;
    }
    const view = { name: 'Liked Songs', tracks, contextUri: uri };
    this.cache = { uri, at: now, view };
    return { ...view };
  }

  async jumpTo(contextUri, position) {
    await this.api('PUT', '/me/player/play', {
      context_uri: contextUri,
      offset: { position },
    });
  }
}

module.exports = { Spotify };
