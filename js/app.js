import { db, uid } from './db.js';
import { Editor } from './editor.js';
import * as drive from './drive.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const $ = s => document.querySelector(s);
const library = $('#library');
const editorEl = $('#editor');

// ---------- 알림 ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- 편집기 ----------
const editor = new Editor(editorEl, {
  toast,
  onSaved: () => {
    editor.setSaveState(drive.hasValidToken() ? '기기에 저장됨 · 드라이브 대기' : '기기에 저장됨', 'ok');
    // 마지막 동작 후 약 3.5초(로컬 저장 0.5초 + 3초) 뒤 드라이브에 올림
    scheduleSync(3000);
  },
  onClose: () => {
    editorEl.hidden = true;
    library.hidden = false;
    renderLibrary();
    scheduleSync(500);
  },
});

async function openNote(id) {
  library.hidden = true;
  editorEl.hidden = false;
  editor.setSaveState('');
  try {
    await editor.open(id);
  } catch (e) {
    console.error(e);
    toast('노트를 열지 못했습니다: ' + e.message);
    editorEl.hidden = true;
    library.hidden = false;
  }
}

// ---------- 서재 ----------
function fmtDate(t) {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('ko-KR', { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
}

async function renderLibrary() {
  const notes = (await db.allNotes()).filter(n => !n.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#empty').hidden = notes.length > 0;
  for (const n of notes) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="cover"></div><div class="name"></div><div class="date"></div>
      <button class="card-menu" aria-label="메뉴"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg></button>`;
    if (n.thumb) card.querySelector('.cover').style.backgroundImage = `url(${n.thumb})`;
    card.querySelector('.name').textContent = n.name;
    card.querySelector('.date').textContent = `${fmtDate(n.updatedAt)} · ${n.pages.length}쪽`;
    card.onclick = e => { if (!e.target.closest('.card-menu')) openNote(n.id); };
    card.querySelector('.card-menu').onclick = e => { e.stopPropagation(); cardMenu(n, e.currentTarget); };
    grid.appendChild(card);
  }
}

function closePopups() { document.querySelectorAll('.popup').forEach(p => p.remove()); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('.popup')) closePopups(); });

function cardMenu(note, anchor) {
  closePopups();
  const m = document.createElement('div');
  m.className = 'popup';
  m.innerHTML = '<button data-a="rename">이름 바꾸기</button><button data-a="dup">복제</button><button data-a="del" class="danger">삭제</button>';
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
  m.onclick = async e => {
    const a = e.target.dataset.a;
    if (!a) return;
    closePopups();
    if (a === 'rename') {
      const name = prompt('노트 이름', note.name);
      if (!name || !name.trim()) return;
      note.name = name.trim();
      note.updatedAt = Date.now();
      await db.putNote(note);
    } else if (a === 'dup') {
      const id = uid();
      const copy = Object.assign({}, note, { id, name: note.name + ' 사본', createdAt: Date.now(), updatedAt: Date.now() });
      if (note.hasPdf) await db.putPdf(id, await db.getPdf(note.id));
      await db.putInk(id, await db.getInk(note.id));
      await db.putNote(copy);
    } else if (a === 'del') {
      if (!confirm(`'${note.name}'을(를) 삭제할까요?\n동기화된 다른 기기와 구글 드라이브에서도 삭제됩니다.`)) return;
      await db.delPdf(note.id);
      await db.delInk(note.id);
      await db.putNote({ id: note.id, name: note.name, deleted: true, updatedAt: Date.now() });
    }
    renderLibrary();
    scheduleSync(500);
  };
}

// ---------- PDF 불러오기 / 새 노트 ----------
async function importPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    pages.push({ id: uid(), w: Math.round(vp.width * 10) / 10, h: Math.round(vp.height * 10) / 10, pdf: i - 1 });
  }
  // 첫 페이지 썸네일
  const p1 = await pdf.getPage(1);
  const v1 = p1.getViewport({ scale: 1 });
  const c = document.createElement('canvas');
  const vp = p1.getViewport({ scale: 360 / v1.width });
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await p1.render({ canvasContext: ctx, viewport: vp }).promise;
  pdf.destroy();
  const id = uid();
  const now = Date.now();
  await db.putPdf(id, new Blob([buf], { type: 'application/pdf' }));
  await db.putInk(id, {});
  await db.putNote({
    id, name: file.name.replace(/\.pdf$/i, ''), hasPdf: true, pages,
    createdAt: now, updatedAt: now, thumb: c.toDataURL('image/jpeg', 0.7),
  });
  return id;
}

async function importFiles(files) {
  const pdfs = [...files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) return toast('PDF 파일만 불러올 수 있습니다');
  let lastId = null;
  for (const f of pdfs) {
    toast(`'${f.name}' 불러오는 중…`, 60000);
    try { lastId = await importPdf(f); }
    catch (e) { console.error(e); toast(`'${f.name}'을(를) 열 수 없습니다: ${e.message}`); return; }
  }
  toast(pdfs.length > 1 ? `PDF ${pdfs.length}개를 불러왔습니다` : 'PDF를 불러왔습니다');
  await renderLibrary();
  scheduleSync(500);
  if (pdfs.length === 1) openNote(lastId);
}

$('#pdf-input').onchange = e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
};

$('#new-blank').onclick = e => {
  closePopups();
  const m = document.createElement('div');
  m.className = 'popup';
  m.innerHTML = '<button data-bg="plain">무지 노트</button><button data-bg="lined">줄 노트</button><button data-bg="grid">모눈 노트</button><button data-bg="dot">점 노트</button>';
  document.body.appendChild(m);
  const r = e.currentTarget.getBoundingClientRect();
  m.style.top = r.bottom + 6 + 'px';
  m.style.left = r.left + 'px';
  m.onclick = async ev => {
    const bg = ev.target.dataset.bg;
    if (!bg) return;
    closePopups();
    const id = uid();
    const now = Date.now();
    const d = new Date(now);
    const pages = [{ id: uid(), w: 595, h: 842, pdf: null, bg }]; // A4
    await db.putInk(id, {});
    await db.putNote({ id, name: `노트 ${d.getMonth() + 1}월 ${d.getDate()}일`, hasPdf: false, pages, createdAt: now, updatedAt: now });
    openNote(id);
  };
};

// 끌어다 놓기 (맥)
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (!library.hidden && e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  if (!library.hidden && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
});

// ---------- 동기화 ----------
let syncTimer;
function scheduleSync(ms) {
  clearTimeout(syncTimer);
  if (!drive.hasValidToken()) return;
  syncTimer = setTimeout(runSync, ms);
}

async function runSync() {
  clearTimeout(syncTimer);
  await editor.flush();
  await drive.sync(async pulledIds => {
    if (editor.note && pulledIds.includes(editor.note.id)) {
      if (editor.active) return; // 쓰는 중이면 다음 동기화 때 반영
      await editor.reload();
      toast('다른 기기에서 바뀐 내용을 불러왔습니다');
    }
    if (!library.hidden) renderLibrary();
  });
}

async function doSignIn(redirect) {
  try {
    if (redirect) return drive.signInRedirect();
    await drive.signIn();
    toast('구글 드라이브에 연결되었습니다');
    runSync();
  } catch (e) {
    if (e.message === 'NO_CLIENT_ID') {
      openSettings();
      $('#client-details').open = true;
      toast('먼저 구글 OAuth 클라이언트 ID를 입력해 주세요');
    } else {
      toast('로그인 실패: ' + e.message + ' — 설정에서 \'다른 방식으로 로그인\'을 시도해 보세요', 5000);
    }
  }
}

function syncLabel(s) {
  switch (s.status) {
    case 'signedout': return '구글 로그인';
    case 'expired': return '다시 로그인';
    case 'syncing': return '동기화 중…';
    case 'offline': return '오프라인';
    case 'error': return '동기화 오류';
    default: return s.lastSync ? '동기화됨 ' + fmtDate(s.lastSync) : '동기화';
  }
}

drive.onChange(s => {
  const b = $('#sync-btn');
  b.dataset.status = s.status;
  b.querySelector('.sync-text').textContent = syncLabel(s);
  b.title = s.message || s.email || '';
  if (s.status === 'error') toast('동기화 오류: ' + s.message, 5000);
  // 편집 화면 아래 저장 상태 표시
  if (!editorEl.hidden && editor.note && !editor.hasPendingSave()) {
    const time = new Date().toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
    if (s.status === 'syncing') editor.setSaveState('드라이브에 저장 중…', 'saving');
    else if (s.status === 'idle') editor.setSaveState(`드라이브까지 저장됨 ✓ ${time}`, 'ok');
    else if (s.status === 'expired') editor.setSaveState('기기에 저장됨 · 드라이브는 로그인 만료(서재에서 다시 로그인)');
    else if (s.status === 'offline') editor.setSaveState('기기에 저장됨 · 오프라인');
    else if (s.status === 'error') editor.setSaveState('기기에 저장됨 · 드라이브 저장 실패, 다시 시도합니다');
  }
  renderAccount();
});

// 구글 토큰은 1시간마다 만료됨. 서재에서 노트를 열거나 닫는 탭(사용자 동작)에 맞춰
// 조용히 갱신해서 따로 로그인 버튼을 누를 일이 거의 없게 함
document.addEventListener('click', e => {
  if (!e.target.closest('.card, [data-act="back"], #new-blank')) return;
  if (!drive.needsRenew() || !drive.getClientId() || !navigator.onLine) return;
  drive.signIn().then(() => runSync()).catch(err => console.warn('renew', err));
}, true);

$('#sync-btn').onclick = () => {
  if (drive.hasValidToken()) runSync();
  else doSignIn(false);
};

// ---------- 설정 ----------
function openSettings() {
  $('#client-id').value = drive.getClientId();
  renderAccount();
  $('#settings').showModal();
}
$('#settings-btn').onclick = openSettings;
$('#save-client').onclick = () => {
  const v = $('#client-id').value.trim();
  if (v && !/\.apps\.googleusercontent\.com$/.test(v)) {
    return toast('클라이언트 ID는 구글 이메일이 아니라 "….apps.googleusercontent.com" 으로 끝나는 값입니다', 5000);
  }
  drive.setClientId(v);
  toast('클라이언트 ID를 저장했습니다');
  renderAccount();
};

function renderAccount() {
  const box = $('#account-box');
  if (!box) return;
  const s = drive.state;
  const signed = drive.hasValidToken();
  box.innerHTML = `<div class="account">
    <div>${signed ? `<b>${s.email || '구글 계정'}</b> 으로 연결됨` : s.email ? `<b>${s.email}</b> — 다시 로그인이 필요합니다` : '구글 드라이브에 연결되어 있지 않습니다'}</div>
    ${s.lastSync ? `<div class="muted small">마지막 동기화: ${new Date(s.lastSync).toLocaleString('ko-KR')}</div>` : ''}
    <div class="btns">
      ${signed ? '<button type="button" class="btn primary" data-a="sync">지금 동기화</button><button type="button" class="btn" data-a="out">로그아웃</button>'
        : '<button type="button" class="btn primary" data-a="in">구글로 로그인</button><button type="button" class="btn" data-a="in2">다른 방식으로 로그인</button>'}
    </div></div>`;
  box.onclick = e => {
    const a = e.target.dataset.a;
    if (a === 'sync') runSync();
    else if (a === 'out') { if (confirm('로그아웃할까요? 이 기기의 노트는 그대로 남습니다.')) drive.signOut(); }
    else if (a === 'in') doSignIn(false);
    else if (a === 'in2') doSignIn(true);
  };
}

// ---------- 시작 ----------
drive.init();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
renderLibrary();
if (drive.hasValidToken()) runSync();

// 앱으로 돌아오면 / 온라인이 되면 동기화
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(300);
  // 다른 앱으로 넘어가면 기다리지 않고 바로 저장·업로드
  else if (drive.hasValidToken()) runSync();
  else editor.flush();
});
window.addEventListener('online', () => scheduleSync(300));
window.addEventListener('pagehide', () => editor.flush());
setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 60_000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}
