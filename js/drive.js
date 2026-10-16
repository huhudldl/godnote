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
    const r = await api(`${API}/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)&pageToken=${pageToken}`);
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

// 노트 하나를 드라이브에 올림 (json = 메타 + 필기, pdf = 원본)
async function pushNote(note, remote, folder) {
  const ink = note.deleted ? {} : await db.getInk(note.id);
  const payload = JSON.stringify({ format: 'godnote', version: 1, note, ink });
  const props = { godnote: 'data', noteId: note.id, updatedAt: String(note.updatedAt), deleted: note.deleted ? '1' : '0' };
  const meta = { name: safeName(note.name) + '.godnote.json', mimeType: 'application/json', appProperties: props };
  if (!remote.json) meta.parents = [folder];
  await upload(remote.json && remote.json.id, meta, new Blob([payload], { type: 'application/json' }));

  if (note.deleted) {
    if (remote.pdf) await removeRemote(remote.pdf.id);
  } else if (note.hasPdf && !remote.pdf) {
    const pdf = await db.getPdf(note.id);
    if (pdf) {
      await upload(null, {
        name: safeName(note.name) + '.pdf',
        mimeType: 'application/pdf',
        parents: [folder],
        appProperties: { godnote: 'pdf', noteId: note.id },
      }, pdf);
    }
  }
}

async function pullNote(remote, local) {
  const blob = await download(remote.json.id);
  // 내려받는 사이 이 기기에서 더 고쳤다면 덮어쓰지 않음 (다음 동기화 때 올라감)
  const cur = await db.getNote(remote.json.appProperties.noteId);
  if (cur && local && (cur.updatedAt || 0) > (local.updatedAt || 0)) return null;
  const data = JSON.parse(await blob.text());
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
  // 썸네일은 기기별로 다시 만들 수 있게 유지
  if (local && local.thumb && !note.thumb) note.thumb = local.thumb;
  await db.putInk(note.id, data.ink || {});
  await db.putNote(note);
  return note;
}

// 전체 동기화: updatedAt 이 더 최신인 쪽이 이김 (노트 단위)
// onPulled(noteIds) 는 원격에서 내려받아 바뀐 노트 목록을 알려줌
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
  try {
    const folder = await ensureFolder();
    const files = await listRemote(folder);
    const remotes = {};
    for (const f of files) {
      const p = f.appProperties || {};
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
      if (!r.json) {
        if (!note.deleted) await pushNote(note, r, folder);
      } else if ((note.updatedAt || 0) > ru) {
        await pushNote(note, r, folder);
      } else if ((note.updatedAt || 0) < ru) {
        if (await pullNote(r, note)) pulled.push(note.id);
      } else if (note.hasPdf && !note.deleted && !r.pdf) {
        await pushNote(note, r, folder);
      }
    }
    for (const id in remotes) {
      const r = remotes[id];
      if (localMap[id] || !r.json) continue;
      await pullNote(r, null);
      pulled.push(id);
    }
    const now = Date.now();
    localStorage.setItem('godnote.lastSync', String(now));
    emit({ status: 'idle', message: '', lastSync: now });
  } catch (e) {
    if (e.message !== 'TOKEN_EXPIRED') emit({ status: 'error', message: e.message });
    console.error(e);
  } finally {
    syncing = false;
  }
  if (pulled.length && onPulled) onPulled(pulled);
  if (pendingResync) { pendingResync = false; return sync(onPulled); }
}
