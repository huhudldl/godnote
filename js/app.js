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
  onExport: id => exportNote(id),
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
  const rec = await db.getNote(id);
  if (rec && !rec.deleted) { rec.openedAt = Date.now(); await db.putNote(rec); }
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
const FOLDERS_ID = '__folders__';   // 폴더 목록도 노트처럼 동기화되는 특별한 기록
const TRASH_DAYS = 30;
let view = localStorage.getItem('godnote.view') || 'all';   // all | trash | 폴더 id

function fmtDate(t) {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('ko-KR', { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
}

async function getFolders() {
  const rec = await db.getNote(FOLDERS_ID);
  return rec && rec.folders ? rec.folders : [];
}
async function saveFolders(folders) {
  await db.putNote({ id: FOLDERS_ID, kind: 'folders', name: '폴더 목록', folders, updatedAt: Date.now() });
  scheduleSync(500);
}
const isNote = n => n.id !== FOLDERS_ID && n.kind !== 'folders' && !n.deleted;

// 휴지통에서 30일이 지난 노트는 완전히 삭제
async function purgeTrash() {
  const limit = Date.now() - TRASH_DAYS * 86400_000;
  for (const n of await db.allNotes()) {
    if (isNote(n) && n.trashedAt && n.trashedAt < limit) await deleteForever(n);
  }
}
async function deleteForever(note) {
  await db.delPdf(note.id);
  await db.delInk(note.id);
  await db.putNote({ id: note.id, name: note.name, deleted: true, updatedAt: Date.now() });
}

function svgIcon(name) {
  const p = {
    dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  }[name];
  return `<svg viewBox="0 0 24 24">${p}</svg>`;
}

async function renderLibrary() {
  const all = await db.allNotes();
  const folders = (all.find(n => n.id === FOLDERS_ID) || {}).folders || [];
  const folderIds = new Set(folders.map(f => f.id));
  if (view !== 'all' && view !== 'trash' && !folderIds.has(view)) view = 'all';
  localStorage.setItem('godnote.view', view);
  const notes = all.filter(isNote);
  const live = notes.filter(n => !n.trashedAt);
  const trashed = notes.filter(n => n.trashedAt);

  // 폴더 줄
  const bar = $('#folders');
  bar.innerHTML = '';
  const chip = (id, label, count, icon) => {
    const b = document.createElement('button');
    b.className = 'chip' + (view === id ? ' on' : '') + (id === 'trash' ? ' trash' : '') + (icon === 'folder' ? ' folder' : '');
    b.innerHTML = (icon ? svgIcon(icon) : '') + `<span></span>` + (count != null ? `<em>${count}</em>` : '');
    b.querySelector('span').textContent = label;
    b.onclick = () => {
      if (view === id && folderIds.has(id)) return folderMenu(folders.find(f => f.id === id), b);
      view = id;
      renderLibrary();
    };
    bar.appendChild(b);
  };
  chip('all', '전체', live.length);
  for (const f of folders) chip(f.id, f.name, live.filter(n => n.folderId === f.id).length, 'folder');
  const add = document.createElement('button');
  add.className = 'chip add';
  add.innerHTML = svgIcon('plus') + '<span>새 폴더</span>';
  add.onclick = async () => {
    const name = prompt('새 폴더 이름');
    if (!name || !name.trim()) return;
    const f = { id: uid(), name: name.trim() };
    await saveFolders([...folders, f]);
    view = f.id;
    renderLibrary();
  };
  bar.appendChild(add);
  const sp = document.createElement('div');
  sp.className = 'spacer';
  bar.appendChild(sp);
  chip('trash', '휴지통', trashed.length || null, 'trash');

  // 노트 목록 (검색어가 있으면 모든 폴더에서 이름으로 찾기)
  const rawQ = $('#lib-search').value.trim();
  const q = rawQ.toLowerCase();
  let list;
  if (q) list = (view === 'trash' ? trashed : live).filter(n => n.name.toLowerCase().includes(q));
  else if (view === 'trash') list = trashed.sort((a, b) => b.trashedAt - a.trashedAt);
  else if (view === 'all') list = live;
  else list = live.filter(n => n.folderId === view);
  if (view !== 'trash') list.sort((a, b) => b.updatedAt - a.updatedAt);

  $('.actions').hidden = view === 'trash';
  $('#trash-head').hidden = view !== 'trash';
  $('#empty-trash').disabled = !trashed.length;
  $('#title-results').hidden = !q || !list.length;

  // 최근에 연 노트 (검색·휴지통이 아닐 때)
  const recent = live.filter(n => n.openedAt && (view === 'all' || n.folderId === view)).sort((a, b) => b.openedAt - a.openedAt).slice(0, 4);
  const recentBox = $('#recent');
  recentBox.hidden = !!q || view === 'trash' || !recent.length || list.length < 5;
  if (!recentBox.hidden) {
    const rl = recentBox.querySelector('.recent-list');
    rl.innerHTML = '';
    for (const n of recent) {
      const idx = n.lastPage ? n.pages.findIndex(p => p.id === n.lastPage) : -1;
      const b = document.createElement('button');
      b.className = 'recent-item';
      b.innerHTML = `<span class="rthumb"></span><span class="rtext"><b></b><small></small></span>`;
      if (n.thumb) b.querySelector('.rthumb').style.backgroundImage = `url(${n.thumb})`;
      b.querySelector('b').textContent = n.name;
      b.querySelector('small').textContent = idx > 0 ? `${idx + 1}쪽에서 이어 보기` : `${n.pages.length}쪽`;
      b.onclick = () => openNote(n.id);
      rl.appendChild(b);
    }
  }

  const empty = $('#empty');
  empty.hidden = list.length > 0;
  empty.querySelector('p').textContent = q ? `제목에 '${rawQ}'이(가) 들어간 노트가 없습니다.` : view === 'trash' ? '휴지통이 비어 있습니다.' : '아직 노트가 없습니다.';
  empty.querySelector('.muted').hidden = view === 'trash' || !!q;
  libState = { list, folders, q };
  layoutCards();
  if (q.replace(/\s/g, '').length >= 2 && view !== 'trash') searchContents(rawQ, live);
  else { searchToken = {}; $('#content-results').hidden = true; }
}

// ---------- 벽돌(메이슨리) 카드 배치 ----------
let libState = { list: [], folders: [], q: '' };
let lastCols = 0;

function makeCard(n, folders, q) {
  const folderName = id => (folders.find(f => f.id === id) || {}).name;
  const card = document.createElement('div');
  card.className = 'card' + (n.trashedAt ? ' in-trash' : '');
  const pg = n.pages && n.pages[0];
  const ratio = pg ? `${pg.w} / ${pg.h}` : '3 / 4';
  card.innerHTML = `<div class="cover" style="aspect-ratio:${ratio}"><img alt="" loading="lazy" draggable="false"></div>
    <button class="card-menu" aria-label="메뉴">${svgIcon('dots')}</button>
    <div class="name"></div><div class="date"></div>`;
  const img = card.querySelector('img');
  if (n.thumb) img.src = n.thumb; else img.remove();
  card.querySelector('.name').textContent = n.name;
  let info;
  if (n.trashedAt) {
    const left = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - n.trashedAt) / 86400_000));
    info = `${left}일 후 완전 삭제`;
  } else {
    info = `${fmtDate(n.updatedAt)} · ${n.pages.length}쪽`;
    if ((view === 'all' || q) && folderName(n.folderId)) info += ` · ${folderName(n.folderId)}`;
  }
  card.querySelector('.date').textContent = info;
  card.onclick = e => {
    if (e.target.closest('.card-menu')) return;
    if (n.trashedAt) return cardMenu(n, card.querySelector('.card-menu'), folders);
    openNote(n.id);
  };
  card.querySelector('.card-menu').onclick = e => { e.stopPropagation(); cardMenu(n, e.currentTarget, folders); };
  return card;
}

function layoutCards() {
  const grid = $('#grid');
  const { list, folders, q } = libState;
  const w = grid.clientWidth || library.clientWidth - 32;
  const gap = w < 600 ? 12 : 18;
  const target = w < 600 ? 150 : 210;
  const cols = Math.max(2, Math.floor((w + gap) / (target + gap)));
  lastCols = cols;
  const colW = (w - gap * (cols - 1)) / cols;
  grid.innerHTML = '';
  grid.style.gap = gap + 'px';
  const colEls = [], heights = [];
  for (let i = 0; i < cols; i++) {
    const c = document.createElement('div');
    c.className = 'mcol';
    c.style.gap = gap + 4 + 'px';
    grid.appendChild(c);
    colEls.push(c);
    heights.push(0);
  }
  // 가장 짧은 줄에 다음 카드를 넣어 핀터레스트처럼 쌓음
  for (const n of list) {
    const pg = n.pages && n.pages[0];
    const h = colW * (pg ? pg.h / pg.w : 4 / 3) + 52;
    const i = heights.indexOf(Math.min(...heights));
    colEls[i].appendChild(makeCard(n, folders, q));
    heights[i] += h + gap;
  }
}
new ResizeObserver(() => {
  if (library.hidden) return;
  const w = $('#grid').clientWidth;
  const gap = w < 600 ? 12 : 18;
  const cols = Math.max(2, Math.floor((w + gap) / ((w < 600 ? 150 : 210) + gap)));
  if (cols !== lastCols) layoutCards();
}).observe($('#grid'));

// ---------- 노트 내용 검색 (PDF 글자 + 직접 쓴 텍스트) ----------
const pdfTextCache = new Map();   // noteId → [{ pdf, raw, norm, map }]
let searchToken = {};

function normWithMap(raw) {
  let norm = '';
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) continue;
    norm += raw[i].toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

async function pdfTexts(note) {
  if (pdfTextCache.has(note.id)) return pdfTextCache.get(note.id);
  const blob = await db.getPdf(note.id);
  const out = [];
  if (blob) {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      const raw = tc.items.map(it => it.str + (it.hasEOL ? ' ' : '')).join('');
      out.push(Object.assign({ pdf: i - 1, raw }, normWithMap(raw)));
    }
    doc.destroy();
  }
  pdfTextCache.set(note.id, out);
  return out;
}

async function searchContents(rawQ, notes) {
  const token = (searchToken = {});
  const box = $('#content-results');
  const listEl = box.querySelector('.cr-list');
  const status = box.querySelector('.cr-status');
  const nq = rawQ.replace(/\s+/g, '').toLowerCase();
  listEl.innerHTML = '';
  box.hidden = false;
  let found = 0;
  for (let k = 0; k < notes.length; k++) {
    const n = notes[k];
    status.textContent = `찾는 중… ${k + 1} / ${notes.length}`;
    const hits = [];
    try {
      if (n.hasPdf) {
        for (const pt of await pdfTexts(n)) {
          const at = pt.norm.indexOf(nq);
          if (at < 0) continue;
          const i = n.pages.findIndex(p => p.pdf === pt.pdf);
          if (i < 0) continue;
          const s0 = pt.map[at], s1 = pt.map[at + nq.length - 1] + 1;
          hits.push({ i, before: pt.raw.slice(Math.max(0, s0 - 24), s0), match: pt.raw.slice(s0, s1), after: pt.raw.slice(s1, s1 + 36) });
          if (hits.length >= 3) break;
        }
      }
      if (hits.length < 3) {
        const ink = await db.getInk(n.id);
        n.pages.forEach((p, i) => {
          for (const t of ((ink[p.id] || {}).texts || [])) {
            if (hits.length >= 3) return;
            const { norm, map } = normWithMap(t.text);
            const at = norm.indexOf(nq);
            if (at < 0) continue;
            const s0 = map[at], s1 = map[at + nq.length - 1] + 1;
            hits.push({ i, before: t.text.slice(Math.max(0, s0 - 24), s0), match: t.text.slice(s0, s1), after: t.text.slice(s1, s1 + 36) });
          }
        });
      }
    } catch (e) { console.warn('내용 검색', n.name, e); }
    if (token !== searchToken) return;
    for (const h of hits) {
      found++;
      const row = document.createElement('button');
      row.className = 'cr-row';
      row.innerHTML = `<span class="rthumb"></span><span class="rtext"><b></b><small><em></em><span class="snip"></span></small></span>`;
      if (n.thumb) row.querySelector('.rthumb').style.backgroundImage = `url(${n.thumb})`;
      row.querySelector('b').textContent = n.name;
      row.querySelector('em').textContent = `${h.i + 1}쪽`;
      const snip = row.querySelector('.snip');
      snip.append('…' + h.before);
      const mark = document.createElement('mark');
      mark.textContent = h.match;
      snip.append(mark, h.after + '…');
      row.onclick = async () => {
        const cur = await db.getNote(n.id);
        cur.lastPage = cur.pages[h.i].id;   // 그 쪽에서 열기
        await db.putNote(cur);
        openNote(n.id);
      };
      listEl.appendChild(row);
    }
  }
  if (token !== searchToken) return;
  status.textContent = found ? `${found}곳` : '';
  if (!found) box.hidden = true;
  if (found && !libState.list.length) $('#empty').hidden = true;
}

function closePopups() { document.querySelectorAll('.popup').forEach(p => p.remove()); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('.popup') && !e.target.closest('#fab')) closePopups(); });

function popup(anchor, html) {
  closePopups();
  const m = document.createElement('div');
  m.className = 'popup';
  m.innerHTML = html;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)) + 'px';
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
  return m;
}

function folderMenu(folder, anchor) {
  const m = popup(anchor, '<button data-a="rename">폴더 이름 바꾸기</button><button data-a="del" class="danger">폴더 삭제</button>');
  m.onclick = async e => {
    const a = e.target.dataset.a;
    if (!a) return;
    closePopups();
    const folders = await getFolders();
    if (a === 'rename') {
      const name = prompt('폴더 이름', folder.name);
      if (!name || !name.trim()) return;
      await saveFolders(folders.map(f => f.id === folder.id ? { ...f, name: name.trim() } : f));
    } else {
      if (!confirm(`'${folder.name}' 폴더를 삭제할까요?\n안에 있던 노트는 지워지지 않고 '전체'에 남습니다.`)) return;
      for (const n of await db.allNotes()) {
        if (isNote(n) && n.folderId === folder.id) { delete n.folderId; n.updatedAt = Date.now(); await db.putNote(n); }
      }
      await saveFolders(folders.filter(f => f.id !== folder.id));
      view = 'all';
    }
    renderLibrary();
  };
}

function cardMenu(note, anchor, folders) {
  const html = note.trashedAt
    ? '<button data-a="restore">복원</button><button data-a="forever" class="danger">완전히 삭제</button>'
    : '<button data-a="rename">이름 바꾸기</button><button data-a="move">폴더로 이동</button><button data-a="dup">복제</button><button data-a="export">필기 포함 PDF로 내보내기</button><button data-a="del" class="danger">휴지통으로 이동</button>';
  const m = popup(anchor, html);
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
    } else if (a === 'move') {
      return moveMenu(note, anchor, folders);
    } else if (a === 'dup') {
      const id = uid();
      const copy = Object.assign({}, note, { id, name: note.name + ' 사본', createdAt: Date.now(), updatedAt: Date.now() });
      if (note.hasPdf) await db.putPdf(id, await db.getPdf(note.id));
      await db.putInk(id, await db.getInk(note.id));
      await db.putNote(copy);
    } else if (a === 'export') {
      return exportNote(note.id);
    } else if (a === 'del') {
      note.trashedAt = Date.now();
      note.updatedAt = Date.now();
      await db.putNote(note);
      toast(`휴지통으로 옮겼습니다 (${TRASH_DAYS}일 동안 보관)`);
    } else if (a === 'restore') {
      delete note.trashedAt;
      note.updatedAt = Date.now();
      await db.putNote(note);
      toast('노트를 복원했습니다');
    } else if (a === 'forever') {
      if (!confirm(`'${note.name}'을(를) 완전히 삭제할까요?\n모든 기기와 구글 드라이브에서 지워지며 되돌릴 수 없습니다.`)) return;
      await deleteForever(note);
    }
    renderLibrary();
    scheduleSync(500);
  };
}

function moveMenu(note, anchor, folders) {
  if (!folders.length) return toast("먼저 위쪽 '새 폴더'로 폴더를 만들어 주세요");
  const items = [{ id: '', name: '폴더 없음' }, ...folders]
    .map(f => `<button data-f="${f.id}">${f.id === (note.folderId || '') ? '✓ ' : ''}${f.name.replace(/</g, '&lt;')}</button>`).join('');
  const m = popup(anchor, items);
  m.onclick = async e => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    closePopups();
    if (b.dataset.f) note.folderId = b.dataset.f; else delete note.folderId;
    note.updatedAt = Date.now();
    await db.putNote(note);
    renderLibrary();
    scheduleSync(500);
  };
}

let searchTimer;
$('#lib-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderLibrary, 150); });

$('#empty-trash').onclick = async () => {
  const trashed = (await db.allNotes()).filter(n => isNote(n) && n.trashedAt);
  if (!trashed.length) return;
  if (!confirm(`휴지통의 노트 ${trashed.length}개를 완전히 삭제할까요?\n되돌릴 수 없습니다.`)) return;
  for (const n of trashed) await deleteForever(n);
  renderLibrary();
  scheduleSync(500);
};

// ---------- PDF 내보내기 ----------
async function exportNote(id) {
  const note = await db.getNote(id);
  if (!note) return;
  try {
    const { exportNotePdf, saveOrShare, shareNow } = await import('./export.js');
    const ink = await db.getInk(id);
    const pdf = note.hasPdf ? await db.getPdf(id) : null;
    const blob = await exportNotePdf(note, ink, pdf, (i, n) => toast(`PDF 만드는 중… ${i} / ${n}쪽`, 60000));
    const name = note.name.replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
    let how = await saveOrShare(blob, name);
    if (how === 'needTap') {
      // PDF 를 만드는 동안 시간이 지나 바로 공유 창을 열 수 없을 때: 준비 완료 창에서 한 번 더 누름
      $('#toast').hidden = true;
      const dlg = $('#share-ready');
      dlg.querySelector('.share-name').textContent = name;
      dlg.showModal();
      how = await new Promise(resolve => {
        dlg.querySelector('[data-a="share"]').onclick = async () => { dlg.close(); resolve(await shareNow(blob, name)); };
        dlg.querySelector('[data-a="cancel"]').onclick = () => { dlg.close(); resolve('cancelled'); };
      });
    }
    if (how === 'downloaded') toast(`'${name}'을(를) 다운로드 폴더에 저장했습니다`, 4000);
    else if (how === 'shared') toast('PDF를 내보냈습니다');
    else if (how === 'failed') toast('공유 창을 열지 못했습니다. 다시 시도해 주세요', 4000);
    else toast('내보내기를 취소했습니다');
  } catch (e) {
    console.error(e);
    toast('PDF를 만들지 못했습니다: ' + e.message, 5000);
  }
}

// ---------- PDF 불러오기 / 새 노트 ----------
const currentFolder = () => (view !== 'all' && view !== 'trash' ? { folderId: view } : {});
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
    id, name: file.name.replace(/\.pdf$/i, ''), hasPdf: true, pages, ...currentFolder(),
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

$('#fab').onclick = e => {
  e.stopPropagation();
  if (document.querySelector('.popup.fab-menu')) return closePopups();
  closePopups();
  const m = document.createElement('div');
  m.className = 'popup fab-menu';
  m.innerHTML = `<button data-act="pdf"><b>PDF 불러오기</b><small>파일 앱·다운로드에서 고르기</small></button>
    <div class="fab-sep">새 노트</div>
    <div class="paper-grid">
      <button data-bg="plain"><i class="paper plain"></i>무지</button>
      <button data-bg="lined"><i class="paper lined"></i>줄</button>
      <button data-bg="grid"><i class="paper grid"></i>모눈</button>
      <button data-bg="dot"><i class="paper dot"></i>점</button>
    </div>`;
  document.body.appendChild(m);
  const r = e.currentTarget.getBoundingClientRect();
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
  m.style.top = Math.max(8, r.top - m.offsetHeight - 10) + 'px';
  m.onclick = async ev => {
    if (ev.target.closest('[data-act="pdf"]')) { closePopups(); return $('#pdf-input').click(); }
    const bgBtn = ev.target.closest('[data-bg]');
    const bg = bgBtn && bgBtn.dataset.bg;
    if (!bg) return;
    closePopups();
    const id = uid();
    const now = Date.now();
    const d = new Date(now);
    const pages = [{ id: uid(), w: 595, h: 842, pdf: null, bg }]; // A4
    await db.putInk(id, {});
    await db.putNote({ id, name: `노트 ${d.getMonth() + 1}월 ${d.getDate()}일`, hasPdf: false, pages, createdAt: now, updatedAt: now, ...currentFolder() });
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
  try {
    await editor.flush();
    await drive.sync(async (pulledIds, conflicts) => {
      if (conflicts) toast(`두 기기에서 같은 노트를 고쳐서 '충돌 사본' ${conflicts}개를 만들었습니다. 서재에서 확인하세요`, 6000);
      if (editor.note && pulledIds.includes(editor.note.id)) reloadEditor().catch(e => console.error(e));
      if (!library.hidden) renderLibrary();
    });
  } catch (e) {
    console.error('동기화', e);
  }
}

// 다른 기기 내용으로 편집 화면 갱신. 아직 저장 안 된 필기가 있으면 사본으로 남김
async function reloadEditor() {
  if (!editor.note) return;
  if (editor.active) return setTimeout(reloadEditor, 300);
  if (editor.hasPendingSave()) {
    await editor.saveAsCopy();
    toast("다른 기기에서 바뀐 내용을 불러왔고, 방금 쓴 내용은 '충돌 사본'으로 남겼습니다", 6000);
  } else toast('다른 기기에서 바뀐 내용을 불러왔습니다');
  await editor.reload();
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

let lastSyncError = '';
drive.onChange(s => {
  const b = $('#sync-btn');
  b.dataset.status = s.status;
  b.querySelector('.sync-text').textContent = syncLabel(s);
  b.title = s.message || s.email || '';
  // 같은 오류는 1분마다 다시 띄우지 않고, 한 번 성공하거나 내용이 바뀔 때만 다시 알림
  if (s.status === 'error' && s.message !== lastSyncError) toast('동기화 오류: ' + s.message, 6000);
  if (s.status === 'error') lastSyncError = s.message;
  else if (s.status === 'idle') lastSyncError = '';
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
  if (!e.target.closest('.card, .recent-item, .cr-row, [data-act="back"], #fab')) return;
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

// function 선언이어야 위쪽의 drive.onChange 가 시작할 때 바로 불러도 동작함
function esc(v) {
  return String(v || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderAccount() {
  const box = $('#account-box');
  if (!box) return;
  const s = drive.state;
  const signed = drive.hasValidToken();
  box.innerHTML = `<div class="account">
    <div>${signed ? `<b>${esc(s.email) || '구글 계정'}</b> 으로 연결됨` : s.email ? `<b>${esc(s.email)}</b> — 다시 로그인이 필요합니다` : '구글 드라이브에 연결되어 있지 않습니다'}</div>
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

// ---------- 화면 모드 (자동 · 라이트 · 다크) ----------
const THEME_KEY = 'godnote.theme';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function themeMode() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : darkQuery.matches;
}
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else { delete document.documentElement.dataset.theme; mode = 'auto'; }
  try { localStorage.setItem(THEME_KEY, mode); } catch {}
  updateThemeUi();
}
function updateThemeUi() {
  const dark = isDark();
  document.querySelector('meta[name="theme-color"]').content = dark ? '#18181a' : '#f6f5f2';
  $('#theme-btn').classList.toggle('is-dark', dark);
  $('#theme-btn').title = dark ? '라이트 모드로 보기' : '다크 모드로 보기';
  const mb = editorEl.querySelector('[data-act="theme"]');
  if (mb) mb.textContent = dark ? '라이트 모드로 보기' : '다크 모드로 보기';
  const mode = themeMode();
  document.querySelectorAll('#theme-seg [data-theme-mode]').forEach(b => b.classList.toggle('on', b.dataset.themeMode === mode));
}
$('#theme-btn').onclick = () => applyTheme(isDark() ? 'light' : 'dark');
editorEl.querySelector('[data-act="theme"]').onclick = () => {
  editorEl.querySelector('.more-menu').hidden = true;
  applyTheme(isDark() ? 'light' : 'dark');
};
document.querySelectorAll('#theme-seg [data-theme-mode]').forEach(b => { b.onclick = () => applyTheme(b.dataset.themeMode); });
darkQuery.addEventListener('change', updateThemeUi);
updateThemeUi();

// ---------- 시작 ----------
drive.init();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
purgeTrash().then(renderLibrary);
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
