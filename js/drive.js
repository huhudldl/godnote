// 구글 드라이브 로그인 + 동기화
// 범위: drive.file (갓 노트가 만든 파일만 접근 가능) + 이메일(계정 표시용)
import { db } from './db.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const FOLDER_NAME = '갓 노트';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const LS_TOKEN = 'godnote.token';
const LS_EMAIL = 'godnote.email';
const LS_CLIENT = 'godnote.clientId';

let token = null;        // { access_token, expires_at }
let tokenClient = null;
let folderId = null;
let listeners = [];
let syncing = false;
let pendingResync = false;

export function getClientId() {
  const v = localStorage.getItem(LS_CLIENT) || (window.GODNOTE_CONFIG && window.GODNOTE_CONFIG.clientId) || '';
  return /\.apps\.googleusercontent\.com$/.test(v) ? v : '';
}
export function setClientId(id) {
  localStorage.setItem(LS_CLIENT, id.trim());
  tokenClient = null;
}

export const state = {
  status: 'signedout',   // signedout | idle | syncing | error | offline | expired
  message: '',
  email: localStorage.getItem(LS_EMAIL) || '',
  lastSync: Number(localStorage.getItem('godnote.lastSync')) || 0,
};
function emit(patch) {
  Object.assign(state, patch);
  listeners.forEach(fn => fn(state));
}
export function onChange(fn) { listeners.push(fn); fn(state); }

function loadToken() {
  try {
    const t = JSON.parse(localStorage.getItem(LS_TOKEN));
    if (t && t.expires_at > Date.now() + 60_000) token = t;
  } catch {}
}
function saveToken(access_token, expires_in) {
  token = { access_token, expires_at: Date.now() + (Number(expires_in) || 3600) * 1000 };
  localStorage.setItem(LS_TOKEN, JSON.stringify(token));
}
export function hasValidToken() {
  return !!token && token.expires_at > Date.now() + 60_000;
}
export function wasSignedIn() { return !!state.email; }
// 곧 만료되거나 만료된 경우 (다시 받아 두는 게 좋은 상태)
export function needsRenew() {
  return !!state.email && (!token || token.expires_at < Date.now() + 10 * 60_000);
}

// 리디렉션 방식 로그인에서 돌아왔을 때 URL 해시의 토큰을 처리
function consumeRedirect() {
  if (!location.hash.includes('access_token=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('state') === sessionStorage.getItem('godnote.oauthState')) {
    saveToken(p.get('access_token'), p.get('expires_in'));
  }
  history.replaceState(null, '', location.pathname + location.search);
}

export function init() {
  consumeRedirect();
  loadToken();
  // 로그인 팝업이 탭 직후 바로 뜨도록 구글 스크립트를 미리 받아 둠
  if (getClientId() && navigator.onLine) loadGis().catch(() => {});
  if (hasValidToken()) emit({ status: 'idle' });
  else if (state.email) emit({ status: 'expired', message: '다시 로그인이 필요합니다' });
  else emit({ status: 'signedout' });
}

function loadGis() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('구글 로그인 스크립트를 불러오지 못했습니다 (인터넷 연결 확인)'));
    document.head.appendChild(s);
  });
}

// 팝업 방식 로그인 (기본). 반드시 버튼 클릭 등 사용자 동작 안에서 호출
export async function signIn() {
  const clientId = getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  await loadGis();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: () => {},
      });
    }
    tokenClient.callback = async resp => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      saveToken(resp.access_token, resp.expires_in);
      await fetchEmail();
      emit({ status: 'idle', message: '' });
      resolve();
    };
    tokenClient.error_callback = err => reject(new Error(err.type === 'popup_closed' ? '로그인 창이 닫혔습니다' : (err.message || err.type)));
    tokenClient.requestAccessToken({ prompt: state.email ? '' : 'consent', login_hint: state.email || undefined });
  });
}

// 리디렉션 방식 로그인 (팝업이 막히는 환경용)
export function signInRedirect() {
  const clientId = getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  const st = Math.random().toString(36).slice(2);
  sessionStorage.setItem('godnote.oauthState', st);
  const redirect = location.origin + location.pathname;
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    state: st,
  });
  if (state.email) q.set('login_hint', state.email);
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

export function signOut() {
  if (token && window.google && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(token.access_token); } catch {}
  }
  token = null;
  folderId = null;
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_EMAIL);
  emit({ status: 'signedout', email: '', message: '' });
}

async function fetchEmail() {
  try {
    const r = await api('https://www.googleapis.com/oauth2/v3/userinfo');
    const j = await r.json();
    if (j.email) {
      localStorage.setItem(LS_EMAIL, j.email);
      emit({ email: j.email });
    }
  } catch {}
}

async function api(url, opts = {}) {
  if (!hasValidToken()) {
    emit({ status: 'expired', message: '로그인이 만료되었습니다' });
    throw new Error('TOKEN_EXPIRED');
  }
  const headers = Object.assign({ Authorization: 'Bearer ' + token.access_token }, opts.headers || {});
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  if (r.status === 401) {
    token = null;
    localStorage.removeItem(LS_TOKEN);
    emit({ status: 'expired', message: '로그인이 만료되었습니다' });
    throw new Error('TOKEN_EXPIRED');
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`드라이브 오류 ${r.status}: ${text.slice(0, 200)}`);
  }
  return r;
}

async function ensureFolder() {
  if (folderId) return folderId;
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='godnote' and value='root' }`;
  const r = await api(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  const j = await r.json();
  if (j.files && j.files.length) return (folderId = j.files[0].id);
  const c = await api(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { godnote: 'root' } }),
  });
  return (folderId = (await c.json()).id);
}

async function listRemote(folder) {
  const files = [];
  let pageToken = '';
  do {
    const q = `'${folder}' in parents and trashed=false`;
    const r = await api(`${API}/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties,createdTime)&pageToken=${pageToken}`);
    const j = await r.json();
    files.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

function multipart(metadata, blob) {
  const boundary = 'godnote' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  return { body, type: `multipart/related; boundary=${boundary}` };
}

async function upload(fileId, metadata, blob) {
  const { body, type } = multipart(metadata, blob);
  const url = fileId
    ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id`
    : `${UPLOAD}/files?uploadType=multipart&fields=id`;
  const r = await api(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': type }, body });
  return (await r.json()).id;
}

async function download(fileId) {
  const r = await api(`${API}/files/${fileId}?alt=media`);
  return r.blob();
}

async function removeRemote(fileId) {
  await api(`${API}/files/${fileId}`, { method: 'DELETE' }).catch(() => {});
}

function safeName(name) {
  return (name || '노트').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
}

// ---------- 이미지 분리 저장 ----------
// 노트 json 안에 이미지를 넣지 않고 '갓 노트' 폴더에 이미지 파일로 따로 올림 (같은 이미지는 한 번만)
// json 에는 "asset:<해시>" 만 남겨서, 글자 하나 고쳐도 이미지까지 다시 올리지 않게 함
const assetCache = new Map();   // 해시 → dataURL

async function hashOf(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}

async function packInk(ink, ctx) {
  const out = JSON.parse(JSON.stringify(ink || {}));
  for (const pid in out) {
    for (const im of (out[pid].images || [])) {
      if (!im.src || !im.src.startsWith('data:')) continue;
      const h = await hashOf(im.src);
      assetCache.set(h, im.src);
      if (!ctx.assets[h]) {
        const blob = await (await fetch(im.src)).blob();
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const id = await upload(null, { name: `이미지-${h.slice(0, 10)}.${ext}`, mimeType: blob.type, parents: [ctx.folder], appProperties: { godnote: 'asset', hash: h } }, blob);
        ctx.assets[h] = { id };
      }
      im.src = 'asset:' + h;
    }
  }
  return out;
}

async function unpackInk(ink, ctx, localInk) {
  // 이 기기에 이미 있는 같은 이미지는 다시 받지 않음
  for (const pid in (localInk || {})) for (const im of (localInk[pid].images || [])) {
    if (im.src && im.src.startsWith('data:') && assetCache.size < 500) assetCache.set(await hashOf(im.src), im.src);
  }
  for (const pid in ink) {
    for (const im of (ink[pid].images || [])) {
      if (!im.src || !im.src.startsWith('asset:')) continue;
      const h = im.src.slice(6);
      if (!assetCache.has(h) && ctx.assets[h]) assetCache.set(h, await blobToDataUrl(await download(ctx.assets[h].id)));
      if (assetCache.has(h)) im.src = assetCache.get(h);
    }
  }
  return ink;
}

// ---------- 충돌 판단용 기록: 마지막으로 두 쪽이 같았던 버전 ----------
const LS_BASE = 'godnote.syncBase';
function loadBase() { try { return JSON.parse(localStorage.getItem(LS_BASE)) || {}; } catch { return {}; } }

// 노트 하나를 드라이브에 올림 (json = 메타 + 필기, pdf = 원본)
async function pushNote(note, remote, ctx) {
  const ink = note.deleted ? {} : await packInk(await db.getInk(note.id), ctx);
  const payload = JSON.stringify({ format: 'godnote', version: 2, note, ink });
  const props = { godnote: 'data', noteId: note.id, updatedAt: String(note.updatedAt), deleted: note.deleted ? '1' : '0' };
  const meta = { name: safeName(note.name) + '.godnote.json', mimeType: 'application/json', appProperties: props };
  if (!remote.json) meta.parents = [ctx.folder];
  await upload(remote.json && remote.json.id, meta, new Blob([payload], { type: 'application/json' }));

  if (note.deleted) {
    if (remote.pdf) await removeRemote(remote.pdf.id);
  } else if (note.hasPdf && !remote.pdf) {
    const pdf = await db.getPdf(note.id);
    if (pdf) {
      await upload(null, {
        name: safeName(note.name) + '.pdf',
        mimeType: 'application/pdf',
        parents: [ctx.folder],
        appProperties: { godnote: 'pdf', noteId: note.id },
      }, pdf);
    }
  }
}

async function fetchRemoteData(remote) {
  return JSON.parse(await (await download(remote.json.id)).text());
}

async function pullNote(remote, local, ctx, force) {
  const data = await fetchRemoteData(remote);
  // 내려받는 사이 이 기기에서 더 고쳤다면 덮어쓰지 않음 (다음 동기화 때 올라감)
  const cur = await db.getNote(remote.json.appProperties.noteId);
  if (!force && cur && local && (cur.updatedAt || 0) > (local.updatedAt || 0)) return null;
  const note = data.note;
  if (note.deleted) {
    await db.delPdf(note.id);
    await db.delInk(note.id);
    await db.putNote({ id: note.id, deleted: true, updatedAt: note.updatedAt, name: note.name });
    return note;
  }
  if (note.hasPdf && remote.pdf) {
    const havePdf = local && !local.deleted && (await db.getPdf(note.id));
    if (!havePdf) {
      const pdf = await download(remote.pdf.id);
      await db.putPdf(note.id, new Blob([pdf], { type: 'application/pdf' }));
    }
  }
  // 썸네일·마지막 페이지는 기기별 정보라 이 기기 것을 유지
  if (local && local.thumb && !note.thumb) note.thumb = local.thumb;
  if (local && local.openedAt) note.openedAt = Math.max(local.openedAt, note.openedAt || 0);
  const localInk = local && !local.deleted ? await db.getInk(note.id) : null;
  await db.putInk(note.id, await unpackInk(data.ink || {}, ctx, localInk));
  await db.putNote(note);
  return note;
}

// 두 기기에서 같은 노트를 고친 경우: 이 기기 내용을 '충돌 사본'으로 따로 보관하고 원래 노트는 다른 기기 내용으로
async function keepConflictCopy(local) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const d = new Date();
  const stamp = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const copy = Object.assign({}, local, { id, name: `${local.name} (충돌 사본 ${stamp})`, updatedAt: Date.now() });
  delete copy.lastPage;
  if (local.hasPdf) { const pdf = await db.getPdf(local.id); if (pdf) await db.putPdf(id, pdf); }
  await db.putInk(id, await db.getInk(local.id));
  await db.putNote(copy);
  return id;
}

// 폴더 목록은 사본 대신 합침
async function mergeFolders(local, remote, ctx) {
  const data = await fetchRemoteData(remote);
  const byId = new Map();
  for (const f of (data.note.folders || [])) byId.set(f.id, f);
  for (const f of (local.folders || [])) byId.set(f.id, f);
  const merged = Object.assign({}, local, { folders: [...byId.values()], updatedAt: Math.max(Date.now(), remote.updatedAt + 1) });
  await db.putNote(merged);
  await pushNote(merged, remote, ctx);
  return merged.updatedAt;
}

// 하루에 한 번, 어떤 노트도 쓰지 않는 이미지 파일을 정리 (방금 올라온 것은 건드리지 않음)
async function cleanupAssets(ctx) {
  const last = Number(localStorage.getItem('godnote.assetCleanup')) || 0;
  if (Date.now() - last < 86400_000) return;
  localStorage.setItem('godnote.assetCleanup', String(Date.now()));
  const used = new Set();
  for (const n of await db.allNotes()) {
    if (n.deleted) continue;
    const ink = await db.getInk(n.id);
    for (const pid in ink) for (const im of (ink[pid].images || [])) {
      if (im.src && im.src.startsWith('data:')) used.add(await hashOf(im.src));
      // 아직 내려받지 못한 이미지도 쓰는 중이므로 지우지 않음
      else if (im.src && im.src.startsWith('asset:')) used.add(im.src.slice(6));
    }
  }
  const dayAgo = Date.now() - 86400_000;
  for (const h in ctx.assets) {
    const a = ctx.assets[h];
    if (!used.has(h) && a.createdTime && Date.parse(a.createdTime) < dayAgo) await removeRemote(a.id);
  }
}

// 전체 동기화: 노트 단위로 최신 쪽을 반영, 양쪽이 모두 바뀌었으면 충돌 사본을 만듦
// onPulled(noteIds, conflicts) 는 원격에서 내려받아 바뀐 노트와 충돌 사본 수를 알려줌
export async function sync(onPulled) {
  if (syncing) { pendingResync = true; return; }
  if (!hasValidToken()) {
    emit({ status: state.email ? 'expired' : 'signedout' });
    return;
  }
  if (!navigator.onLine) { emit({ status: 'offline', message: '오프라인 — 연결되면 동기화합니다' }); return; }
  syncing = true;
  emit({ status: 'syncing', message: '동기화 중…' });
  const pulled = [];
  let conflicts = 0;
  const base = loadBase();
  try {
    const folder = await ensureFolder();
    const files = await listRemote(folder);
    const remotes = {};
    const ctx = { folder, assets: {} };
    for (const f of files) {
      const p = f.appProperties || {};
      if (p.godnote === 'asset' && p.hash) { ctx.assets[p.hash] = { id: f.id, createdTime: f.createdTime }; continue; }
      if (!p.noteId) continue;
      const r = remotes[p.noteId] || (remotes[p.noteId] = {});
      if (p.godnote === 'data') {
        // 같은 노트 json 이 중복되면 최신 것을 사용
        if (!r.json || Number(p.updatedAt) > r.updatedAt) {
          r.json = f;
          r.updatedAt = Number(p.updatedAt) || 0;
        }
      } else if (p.godnote === 'pdf') r.pdf = f;
    }
    const locals = await db.allNotes();
    const localMap = Object.fromEntries(locals.map(n => [n.id, n]));

    for (const note of locals) {
      const r = remotes[note.id] || {};
      const ru = r.updatedAt || 0;
      const lu = note.updatedAt || 0;
      const b = base[note.id];
      if (!r.json) {
        if (!note.deleted) { await pushNote(note, r, ctx); base[note.id] = lu; }
      } else if (lu === ru) {
        base[note.id] = lu;
        if (note.hasPdf && !note.deleted && !r.pdf) await pushNote(note, r, ctx);
      } else if (b != null && lu > b && ru > b) {
        // 양쪽 모두 마지막 동기화 이후에 바뀜 → 충돌
        if (note.id === '__folders__' || note.kind === 'folders') {
          base[note.id] = await mergeFolders(note, r, ctx);
          pulled.push(note.id);
        } else {
          if (!note.deleted) { await keepConflictCopy(note); conflicts++; pendingResync = true; }
          await pullNote(r, note, ctx, true);
          base[note.id] = ru;
          pulled.push(note.id);
        }
      } else if (lu > ru) {
        await pushNote(note, r, ctx);
        base[note.id] = lu;
      } else {
        if (await pullNote(r, note, ctx)) { pulled.push(note.id); base[note.id] = ru; }
      }
    }
    for (const id in remotes) {
      const r = remotes[id];
      if (localMap[id] || !r.json) continue;
      await pullNote(r, null, ctx);
      base[id] = r.updatedAt;
      pulled.push(id);
    }
    await cleanupAssets(ctx).catch(e => console.warn('정리 실패', e));
    const now = Date.now();
    localStorage.setItem('godnote.lastSync', String(now));
    emit({ status: 'idle', message: '', lastSync: now });
  } catch (e) {
    if (e.message !== 'TOKEN_EXPIRED') emit({ status: 'error', message: e.message });
    console.error(e);
  } finally {
    localStorage.setItem(LS_BASE, JSON.stringify(base));
    syncing = false;
  }
  if ((pulled.length || conflicts) && onPulled) onPulled(pulled, conflicts);
  if (pendingResync) { pendingResync = false; return sync(onPulled); }
}
