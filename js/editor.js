// 노트 편집기: PDF 페이지 렌더링 + 필기(펜/형광펜/지우개/텍스트/이미지/선택)
import { db, uid } from './db.js';
import { PagePanel } from './pages.js';
import { SearchBar } from './search.js';

const MAX_CANVAS_PIXELS = 12_000_000; // iPad 사파리 캔버스 한도 안쪽
const PAGE_GAP = 16;
const LS_TOOLS = 'godnote.tools';
const HL_ALPHA = 0.5;       // 형광펜 진하기. 형광펜 층은 화면에서 '곱하기'로 겹쳐 아래 글자가 그대로 보임
const HL_HOLD_MS = 550;     // 형광펜 끝에서 이만큼 멈추면 직선으로
const PEN_HOLD_MS = 700;    // 펜 끝에서 이만큼 멈추면 도형으로

const DEFAULT_TOOLS = {
  tool: 'pen',
  pen: { color: '#1a1a1a', width: 2 },
  hl: { color: '#ffe14d', width: 14 },
  eraser: { mode: 'partial', size: 10 },
  text: { size: 18 },
  penOnly: false,
  shapeSnap: true,   // 선 끝에서 잠깐 멈추면 직선·원·사각형으로 보정
  hlStraight: true,  // 형광펜 끝에서 잠깐 멈추면 반듯한 직선으로
  favs: [],          // 즐겨찾는 펜 [{ t, c, w }]
  pillPos: 'bottom', // 알약 툴바 위치: bottom | top
};

const r1 = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function emptyPage() { return { strokes: [], texts: [], images: [] }; }

// 점 (px,py) 에서 선분 (ax,ay)-(bx,by) 까지의 거리
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

// 손으로 그린 획을 직선 / 사각형 / 타원으로 인식. 아니면 null
export function recognizeShape(p) {
  const n = p.length / 3;
  if (n < 4) return null;
  let L = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, pr = 0;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    if (i) L += Math.hypot(x - p[i * 3 - 3], y - p[i * 3 - 2]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    pr += p[i * 3 + 2];
  }
  pr = Math.round(pr / n * 100) / 100;
  if (L < 24) return null;
  const x0 = p[0], y0 = p[1], x1 = p[(n - 1) * 3], y1 = p[(n - 1) * 3 + 1];
  const chord = Math.hypot(x1 - x0, y1 - y0);
  let maxDev = 0;
  for (let i = 0; i < n; i++) maxDev = Math.max(maxDev, distToSeg(p[i * 3], p[i * 3 + 1], x0, y0, x1, y1));
  if (chord > L * 0.85 && maxDev < Math.max(4, L * 0.07)) return { p: [x0, y0, pr, x1, y1, pr], closed: false };
  const bw = maxX - minX, bh = maxY - minY, diag = Math.hypot(bw, bh);
  if (chord > diag * 0.3 || bw < 12 || bh < 12) return null;   // 닫힌 도형이 아님
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = bw / 2, ry = bh / 2;
  let errE = 0, errR = 0;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    errE += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
    errR += Math.min(Math.abs(x - minX), Math.abs(x - maxX), Math.abs(y - minY), Math.abs(y - maxY));
  }
  errE /= n;
  errR = errR / n / Math.min(bw, bh);
  const r1_ = v => Math.round(v * 10) / 10;
  if (errR < 0.07 && errR < errE) {
    return { p: [minX, minY, pr, maxX, minY, pr, maxX, maxY, pr, minX, maxY, pr].map(r1_), closed: true };
  }
  if (errE < 0.13) {
    const pts = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      pts.push(r1_(cx + rx * Math.cos(a)), r1_(cy + ry * Math.sin(a)), pr);
    }
    return { p: pts, closed: true };
  }
  if (errR < 0.1) return { p: [minX, minY, pr, maxX, minY, pr, maxX, maxY, pr, minX, maxY, pr].map(r1_), closed: true };
  return null;
}

// 형광펜 직선: 시작점→끝점. 거의 가로(세로)면 흔들린 높이의 평균으로 수평(수직)을 맞춤
const LOCK_DEG = 12;
export function straightLine(p) {
  const n = p.length / 3;
  if (n < 2) return null;
  const x0 = p[0], y0 = p[1], x1 = p[(n - 1) * 3], y1 = p[(n - 1) * 3 + 1];
  if (Math.hypot(x1 - x0, y1 - y0) < 12) return null;
  let sx = 0, sy = 0, pr = 0;
  for (let i = 0; i < n; i++) { sx += p[i * 3]; sy += p[i * 3 + 1]; pr += p[i * 3 + 2]; }
  pr = Math.round(pr / n * 100) / 100;
  const deg = Math.abs(Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI);
  let lock = null, a = [x0, y0], b = [x1, y1];
  if (deg < LOCK_DEG || deg > 180 - LOCK_DEG) { lock = 'h'; a[1] = b[1] = sy / n; }
  else if (Math.abs(deg - 90) < LOCK_DEG) { lock = 'v'; a[0] = b[0] = sx / n; }
  return { p: [r1(a[0]), r1(a[1]), pr, r1(b[0]), r1(b[1]), pr], lock };
}

// 직선·도형(점 몇 개)을 촘촘한 점으로 바꿈: 부분 지우기로 가운데를 지울 수 있게
function densify(s) {
  const p = s.p, n = p.length / 3, out = [];
  const segs = s.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    const steps = Math.max(1, Math.ceil(Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1]) / 2));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push(r1(p[a] + (p[b] - p[a]) * t), r1(p[a + 1] + (p[b + 1] - p[a + 1]) * t), p[a + 2]);
    }
  }
  const last = s.closed ? 0 : (n - 1) * 3;
  out.push(p[last], p[last + 1], p[last + 2]);
  return out;
}

// 점이 다각형(평평한 [x,y,x,y…]) 안에 있는지
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function drawStroke(ctx, s) {
  const p = s.p;
  const n = p.length / 3;
  if (!n) return;
  if (s.k === 'poly') {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.c;
    if (s.t === 'hl') { ctx.globalAlpha = HL_ALPHA; ctx.globalCompositeOperation = 'multiply'; ctx.lineWidth = s.w; }
    else ctx.lineWidth = s.w * (0.35 + 1.3 * (p[2] || 0.5));
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(p[i * 3], p[i * 3 + 1]);
    if (s.closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  if (s.t === 'hl') {
    ctx.save();
    ctx.globalAlpha = HL_ALPHA;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.01, p[1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (p[i * 3] + p[i * 3 + 3]) / 2, my = (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
      ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], mx, my);
    }
    if (n > 1) ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const wOf = pr => s.w * (0.35 + 1.3 * pr);
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], wOf(p[2]) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // 압력에 따라 굵기가 달라지는 곡선: 중점 사이를 2차 곡선으로 잇는다
  let lx = p[0], ly = p[1];
  for (let i = 1; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], pr = p[i * 3 + 2];
    let mx, my;
    if (i < n - 1) { mx = (x + p[i * 3 + 3]) / 2; my = (y + p[i * 3 + 4]) / 2; } else { mx = x; my = y; }
    ctx.beginPath();
    ctx.lineWidth = wOf((pr + p[(i - 1) * 3 + 2]) / 2);
    ctx.moveTo(lx, ly);
    if (i < n - 1) ctx.quadraticCurveTo(x, y, mx, my); else ctx.lineTo(x, y);
    ctx.stroke();
    lx = mx; ly = my;
  }
}

export const hasHighlights = pageInk => !!pageInk && pageInk.strokes.some(s => s.t === 'hl');
export function drawHighlights(ctx, pageInk) {
  if (pageInk) for (const s of pageInk.strokes) if (s.t === 'hl') drawStroke(ctx, s);
}
export function drawPens(ctx, pageInk) {
  if (pageInk) for (const s of pageInk.strokes) if (s.t !== 'hl') drawStroke(ctx, s);
}
// 불투명한 바탕(썸네일·내보내기) 위에 바로 그릴 때: 형광펜 → 펜
export function drawPageInk(ctx, pageInk) {
  drawHighlights(ctx, pageInk);
  drawPens(ctx, pageInk);
}

// CSS(pre-wrap, line-height 1.3)와 비슷하게 줄바꿈
export function wrapLines(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      if (line && ctx.measureText(line + ch).width > maxW) {
        const sp = line.lastIndexOf(' ');
        if (sp > 0 && ch !== ' ') { lines.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
        else { lines.push(line); line = ch === ' ' ? '' : ch; }
      } else line += ch;
    }
    lines.push(line);
  }
  return lines;
}

export function drawTexts(ctx, texts) {
  if (!texts || !texts.length) return;
  ctx.save();
  ctx.textBaseline = 'middle';
  for (const t of texts) {
    ctx.fillStyle = t.c;
    ctx.font = `${t.s}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    const lh = t.s * 1.3;
    wrapLines(ctx, t.text, t.w).forEach((l, j) => ctx.fillText(l, t.x, t.y + lh * (j + 0.5)));
  }
  ctx.restore();
}

export function drawPaper(ctx, w, h, bg) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  if (bg === 'lined') {
    ctx.strokeStyle = '#c9d6e8';
    ctx.lineWidth = 0.6;
    for (let y = 80; y < h - 20; y += 26) { ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(w - 30, y); ctx.stroke(); }
  } else if (bg === 'grid') {
    ctx.strokeStyle = '#dde4ee';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= w; x += 18) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 18) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  } else if (bg === 'dot') {
    ctx.fillStyle = '#b8c2d0';
    for (let x = 18; x < w; x += 18) for (let y = 18; y < h; y += 18) { ctx.beginPath(); ctx.arc(x, y, 0.8, 0, 7); ctx.fill(); }
  }
}

export class Editor {
  constructor(root, { onSaved, onClose, toast, onExport }) {
    this.root = root;
    this.onExport = onExport;
    this.lassoSel = null;  // 올가미로 고른 필기 묶음
    this.onSaved = onSaved;
    this.onClose = onClose;
    this.toast = toast;
    this.scroller = root.querySelector('.pages');
    this.inner = root.querySelector('.pages-inner');
    this.tools = Object.assign({}, DEFAULT_TOOLS, JSON.parse(localStorage.getItem(LS_TOOLS) || '{}'));
    const touchDevice = navigator.maxTouchPoints > 1 && matchMedia('(pointer: coarse)').matches;
    if (touchDevice && !this.tools.palmV2) {
      this.tools.penOnly = true;
      this.tools.palmV2 = true;
      localStorage.setItem(LS_TOOLS, JSON.stringify(this.tools));
    }
    this.lastPenAt = 0;
    this.zoom = 1;
    this.note = null;
    this.ink = {};
    this.pdf = null;
    this.pageEls = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.active = null;    // 진행 중인 펜/지우개 동작
    this.selected = null;  // 선택된 텍스트/이미지
    this.saveTimer = null;
    this.bindUi();
    this.observer = new IntersectionObserver(es => this.onIntersect(es), { root: this.scroller, rootMargin: '60% 0px' });
    this.resizeObs = new ResizeObserver(() => { if (this.note) this.layout(true); });
    this.resizeObs.observe(this.scroller);
    this.panel = new PagePanel(this);
    this.bindPillGrip();
    this.search = new SearchBar(this);
  }

  // ---------- 열기 / 닫기 ----------
  async open(id) {
    this.note = await db.getNote(id);
    this.ink = await db.getInk(id);
    this.dbStamp = this.note.updatedAt || 0;   // 기기에 마지막으로 저장(또는 읽은) 버전
    this.undoStack = [];
    this.redoStack = [];
    this.srcPool = null;
    this.zoom = 1;
    this.editing = null;
    if (this.search) this.search.reset();
    this.setUiHidden(false);
    this.root.querySelector('.title').textContent = this.note.name;
    if (this.pdf) { this.pdf.destroy(); this.pdf = null; }
    if (this.note.hasPdf) {
      const blob = await db.getPdf(id);
      if (blob) {
        const data = new Uint8Array(await blob.arrayBuffer());
        this.pdf = await pdfjsLib.getDocument({ data }).promise;
      }
    }
    this.buildPages();
    this.scroller.scrollTop = 0;
    const lastEl = this.note.lastPage && this.pageEls.get(this.note.lastPage);
    if (lastEl && lastEl.dataset.index !== '0') this.scroller.scrollTop = lastEl.offsetTop - PAGE_GAP;
    this.updateUi();
  }

  // 쓰는 중이면 펜을 뗀 뒤에 다시 불러옴
  reloadWhenIdle() {
    if (!this.note) return;
    if (this.active) { setTimeout(() => this.reloadWhenIdle(), 300); return; }
    this.reload().catch(e => console.error(e));
  }

  async reload() {
    if (!this.note) return;
    const top = this.scroller.scrollTop;
    const note = await db.getNote(this.note.id);
    if (!note || note.deleted) { this.toast('다른 기기에서 삭제된 노트입니다'); return this.close(); }
    this.note = note;
    this.ink = await db.getInk(note.id);
    this.dbStamp = note.updatedAt || 0;
    if (note.hasPdf && !this.pdf) {
      const blob = await db.getPdf(note.id);
      if (blob) this.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    }
    this.undoStack = [];
    this.redoStack = [];
    this.root.querySelector('.title').textContent = note.name;
    this.buildPages();
    this.scroller.scrollTop = top;
    if (this.panel) this.panel.rebuild();
    this.updateUi();
  }

  async close() {
    if (this.panel) this.panel.toggle(false);
    this.finishEditing();
    this.clearLasso();
    this.deselect();
    if (this.note && this.note.pages.length) this.note.lastPage = this.currentPageId();
    this.closing = true;
    const ok = await this.flush();
    this.closing = false;
    if (!ok && !confirm('필기를 기기에 저장하지 못했습니다 (저장 공간 부족일 수 있어요).\n그래도 닫을까요? 닫으면 마지막 변경이 사라질 수 있습니다.')) return;
    const note = this.note;
    if (note) {
      try {
        note.thumb = await this.makeThumb();
        const cur = await db.getNote(note.id);
        // 썸네일과 마지막 페이지는 '수정'이 아니므로 updatedAt 을 바꾸지 않음
        if (cur && !cur.deleted) { cur.thumb = note.thumb; cur.lastPage = note.lastPage; await db.putNote(cur); }
      } catch (e) { console.warn(e); }
    }
    for (const el of this.pageEls.values()) this.releasePage(el);
    this.observer.disconnect();
    this.inner.innerHTML = '';
    this.pageEls.clear();
    if (this.pdf) { this.pdf.destroy(); this.pdf = null; }
    this.note = null;
    this.onClose();
  }

  isOpen(id) { return this.note && this.note.id === id; }

  // ---------- 저장 ----------
  setSaveState(text, cls = '') {
    const el = this.root.querySelector('.save-state');
    el.textContent = text;
    el.className = 'save-state' + (cls ? ' ' + cls : '');
  }

  hasPendingSave() { return !!this.saveTimer; }

  scheduleSave() {
    this.note.updatedAt = Date.now();
    this.setSaveState('저장 중…', 'saving');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  // 저장 대기 중인 내용을 기기(IndexedDB)에 씀. 실패하면 false 를 돌려주고 잠시 뒤 다시 시도
  async flush() {
    if (!this.saveTimer || !this.note) return true;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const note = this.note;
    try {
      if (note.pages.length) note.lastPage = this.currentPageId();
      // 그사이 동기화가 다른 기기 내용으로 바꿔 놓았으면 덮어쓰지 않고 지금 내용은 사본으로 남김
      const cur = await db.getNote(note.id);
      if (cur && (cur.deleted || (cur.updatedAt || 0) !== this.dbStamp)) {
        await this.saveAsCopy();
        this.toast("다른 기기에서 바뀐 내용이 있어, 방금 쓴 내용은 '충돌 사본'으로 남겼습니다", 6000);
        if (!this.closing) this.reloadWhenIdle();
        return true;
      }
      await db.putInk(note.id, this.ink);
      await db.putNote(note);
      this.dbStamp = note.updatedAt || 0;
    } catch (e) {
      console.error('저장 실패', e);
      if (this.note !== note) return false;
      this.setSaveState('기기에 저장하지 못했습니다 · 다시 시도합니다', 'err');
      if (!this.saveFailedShown) { this.saveFailedShown = true; this.toast('필기를 저장하지 못했습니다. 기기 저장 공간을 확인해 주세요', 5000); }
      if (!this.saveTimer) this.saveTimer = setTimeout(() => this.flush(), 3000);
      return false;
    }
    this.saveFailedShown = false;
    this.onSaved(note.id);
    return true;
  }

  // 저장 전인 지금 내용을 새 노트(충돌 사본)로 저장
  async saveAsCopy() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const id = uid();
    const d = new Date();
    const stamp = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    const copy = Object.assign({}, this.note, { id, name: `${this.note.name} (충돌 사본 ${stamp})`, updatedAt: Date.now() });
    delete copy.lastPage;
    if (this.note.hasPdf) { const pdf = await db.getPdf(this.note.id); if (pdf) await db.putPdf(id, pdf); }
    await db.putInk(id, this.ink);
    await db.putNote(copy);
    this.onSaved(id);
  }

  pageInk(pid) { return this.ink[pid] || (this.ink[pid] = emptyPage()); }

  // 실행 취소용 스냅샷. 이미지(dataURL)는 큰 문자열이라 공용 보관소에 한 번만 두고 키로 대신함
  snap(pid) {
    const pool = this.srcPool || (this.srcPool = { byKey: new Map(), bySrc: new Map() });
    return JSON.stringify(this.ink[pid] || emptyPage(), (k, v) => {
      if (k !== 'src' || typeof v !== 'string' || v.length < 200) return v;
      let key = pool.bySrc.get(v);
      if (!key) { key = '@img' + pool.byKey.size; pool.bySrc.set(v, key); pool.byKey.set(key, v); }
      return key;
    });
  }

  unsnap(str) {
    const pool = this.srcPool;
    return JSON.parse(str, (k, v) => (k === 'src' && typeof v === 'string' && v.startsWith('@img') && pool ? pool.byKey.get(v) || v : v));
  }

  commit(pid, before) {
    const after = this.snap(pid);
    if (after === before) return;
    this.undoStack.push({ pid, before, after });
    if (this.panel) this.panel.markDirty(pid);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.scheduleSave();
    this.updateUndoUi();
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    this.deselect();
    this.clearLasso();
    this.ink[a.pid] = this.unsnap(a.before);
    this.redoStack.push(a);
    this.refreshPage(a.pid);
    this.scheduleSave();
    this.updateUndoUi();
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    this.deselect();
    this.clearLasso();
    this.ink[a.pid] = this.unsnap(a.after);
    this.undoStack.push(a);
    this.refreshPage(a.pid);
    this.scheduleSave();
    this.updateUndoUi();
  }

  // ---------- 페이지 배치 ----------
  baseScale() {
    const avail = this.scroller.clientWidth - PAGE_GAP * 2;
    const maxW = Math.max(...this.note.pages.map(p => p.w));
    return Math.max(0.2, avail / maxW);
  }

  get scale() { return this.baseScale() * this.zoom; }

  buildPages() {
    this.clearLasso();
    this.observer.disconnect();
    for (const el of this.pageEls.values()) this.releasePage(el);
    this.inner.innerHTML = '';
    this.pageEls.clear();
    this.note.pages.forEach((pg, i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.pid = pg.id;
      el.dataset.index = i;
      el.innerHTML = '<canvas class="bg"></canvas><div class="items imgs"></div><canvas class="hl"></canvas><canvas class="ink"></canvas><div class="items texts"></div>';
      this.inner.appendChild(el);
      this.pageEls.set(pg.id, el);
      this.observer.observe(el);
    });
    this.layout(false);
  }

  layout(keepPosition) {
    if (!this.note) return;
    const ratio = keepPosition && this.scroller.scrollHeight ? this.scroller.scrollTop / this.scroller.scrollHeight : 0;
    const s = this.scale;
    for (const pg of this.note.pages) {
      const el = this.pageEls.get(pg.id);
      if (!el) continue;
      el.style.width = pg.w * s + 'px';
      el.style.height = pg.h * s + 'px';
      this.renderItems(pg.id);
    }
    if (keepPosition) this.scroller.scrollTop = ratio * this.scroller.scrollHeight;
    if (this.lassoSel) this.updateLassoBox();
    if (this.search && !this.search.bar.hidden) this.search.drawHits();
    clearTimeout(this.rerenderTimer);
    this.rerenderTimer = setTimeout(() => {
      for (const el of this.pageEls.values()) if (el.dataset.visible === '1') this.renderPage(el);
    }, 150);
    this.root.querySelector('.zoom-label').textContent = Math.round(this.zoom * 100) + '%';
  }

  setZoom(z, keep = true) {
    this.zoom = clamp(z, 0.5, 4);
    this.layout(keep);
  }

  onIntersect(entries) {
    for (const e of entries) {
      const el = e.target;
      if (e.isIntersecting) {
        el.dataset.visible = '1';
        this.renderPage(el);
      } else {
        el.dataset.visible = '0';
        this.releasePage(el);
      }
    }
  }

  pageOf(pid) { return this.note.pages.find(p => p.id === pid); }

  renderScale(pg) {
    let rs = this.scale * (window.devicePixelRatio || 1);
    const px = pg.w * pg.h * rs * rs;
    if (px > MAX_CANVAS_PIXELS) rs = Math.sqrt(MAX_CANVAS_PIXELS / (pg.w * pg.h));
    return rs;
  }

  async renderPage(el) {
    const pg = this.pageOf(el.dataset.pid);
    if (!pg) return;
    const rs = this.renderScale(pg);
    if (el._rs === rs) return;
    el._rs = rs;
    const W = Math.round(pg.w * rs), H = Math.round(pg.h * rs);
    const bg = el.querySelector('canvas.bg');
    const inkC = el.querySelector('canvas.ink');
    // 필기 레이어
    inkC.width = W; inkC.height = H;
    this.drawInkCanvas(el, pg);
    // 배경(PDF 또는 종이)
    if (el._task) { el._task.cancel(); el._task = null; }
    if (pg.pdf != null && this.pdf) {
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      try {
        const page = await this.pdf.getPage(pg.pdf + 1);
        if (el._rs !== rs) return;
        const vp = page.getViewport({ scale: rs * pg.w / page.getViewport({ scale: 1 }).width });
        const task = page.render({ canvasContext: off.getContext('2d'), viewport: vp });
        el._task = task;
        await task.promise;
        el._task = null;
        if (el._rs !== rs) return;
        bg.width = W; bg.height = H;
        bg.getContext('2d').drawImage(off, 0, 0);
        off.width = 0; off.height = 0;
      } catch (e) {
        if (e && e.name !== 'RenderingCancelledException') {
          console.warn(e);
          // 메모리 부족 등으로 실패하면 잠시 뒤 한 번 더 그려 봄
          if ((el._retries = (el._retries || 0) + 1) <= 2) setTimeout(() => {
            if (el._rs === rs && el.dataset.visible === '1') { el._rs = 0; this.renderPage(el); }
          }, 1500);
        }
      }
    } else {
      bg.width = W; bg.height = H;
      const ctx = bg.getContext('2d');
      ctx.setTransform(rs, 0, 0, rs, 0, 0);
      drawPaper(ctx, pg.w, pg.h, pg.bg);
    }
  }

  // 펜은 ink 층, 형광펜은 그 아래 hl 층(곱하기 합성). hl 층은 형광펜이 있는 페이지만 메모리를 씀
  drawInkCanvas(el, pg) {
    const rs = el._rs;
    if (!rs) return;
    const pi = this.ink[pg.id];
    const c = el.querySelector('canvas.ink');
    const paint = (canvas, fn) => {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(rs, 0, 0, rs, 0, 0);
      fn(ctx, pi);
    };
    paint(c, drawPens);
    const h = el.querySelector('canvas.hl');
    if (!hasHighlights(pi)) { if (h.width) { h.width = 0; h.height = 0; } return; }
    if (h.width !== c.width || h.height !== c.height) { h.width = c.width; h.height = c.height; }
    paint(h, drawHighlights);
  }

  releasePage(el) {
    if (el._task) { el._task.cancel(); el._task = null; }
    el._rs = 0;
    for (const c of el.querySelectorAll('canvas')) { c.width = 0; c.height = 0; }
  }

  refreshPage(pid) {
    const el = this.pageEls.get(pid);
    if (!el) return;
    if (el._rs) this.drawInkCanvas(el, this.pageOf(pid));
    this.renderItems(pid);
  }

  // ---------- 텍스트 / 이미지 항목 ----------
  renderItems(pid) {
    const el = this.pageEls.get(pid);
    const imgBox = el.querySelector('.items.imgs');
    const box = el.querySelector('.items.texts');
    const s = this.scale;
    const pi = this.ink[pid];
    const keep = new Set();
    if (pi) {
      for (const im of pi.images) {
        keep.add(im.id);
        let d = imgBox.querySelector(`[data-id="${im.id}"]`);
        if (!d) {
          d = document.createElement('div');
          d.className = 'item image';
          d.dataset.id = im.id;
          d.innerHTML = '<img draggable="false" alt="">';
          imgBox.appendChild(d);
        }
        const img = d.querySelector('img');
        if (img.getAttribute('src') !== im.src) img.src = im.src;
        Object.assign(d.style, { left: im.x * s + 'px', top: im.y * s + 'px', width: im.w * s + 'px', height: im.h * s + 'px' });
      }
      for (const t of pi.texts) {
        keep.add(t.id);
        let d = box.querySelector(`[data-id="${t.id}"]`);
        if (!d) {
          d = document.createElement('div');
          d.className = 'item text';
          d.dataset.id = t.id;
          box.appendChild(d);
        }
        if (d.getAttribute('contenteditable') !== 'true' && d.getAttribute('contenteditable') !== 'plaintext-only') d.textContent = t.text;
        Object.assign(d.style, { left: t.x * s + 'px', top: t.y * s + 'px', width: t.w * s + 'px', fontSize: t.s * s + 'px', color: t.c });
      }
    }
    for (const d of [...box.children, ...imgBox.children]) if (!keep.has(d.dataset.id)) d.remove();
    if (this.selected && this.selected.pid === pid) this.positionSelection();
  }

  findItem(pid, id) {
    const pi = this.ink[pid];
    if (!pi) return null;
    return pi.texts.find(t => t.id === id) || pi.images.find(t => t.id === id) || null;
  }

  select(pid, id) {
    this.deselect();
    const el = this.pageEls.get(pid).querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.classList.add('selected');
    this.selected = { pid, id, el, kind: el.classList.contains('text') ? 'text' : 'image' };
    this.showSelbar();
  }

  deselect() {
    if (!this.selected) return;
    this.selected.el.classList.remove('selected');
    this.selected = null;
    if (!this.editing) this.root.querySelector('.selbar').hidden = true;
  }

  // 선택바: 선택된 항목 또는 편집 중인 텍스트에 붙음
  barTarget() { return this.editing || this.selected; }

  showSelbar() {
    const t = this.barTarget();
    const bar = this.root.querySelector('.selbar');
    if (!t) { bar.hidden = true; return; }
    const isText = t.kind === 'text';
    bar.querySelector('.size-ctrl').hidden = !isText;
    bar.querySelector('[data-act="edit"]').hidden = !isText || !!this.editing;
    if (isText) {
      const it = this.findItem(t.pid, t.id);
      if (it) bar.querySelector('.size-val').textContent = it.s;
    }
    bar.hidden = false;
    this.positionSelection();
  }

  // 글자 크기 한 단계 키우기(+1) / 줄이기(-1)
  changeTextSize(dir) {
    const t = this.barTarget();
    if (!t || t.kind !== 'text') return;
    const it = this.findItem(t.pid, t.id);
    if (!it) return;
    const SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];
    let next = dir > 0 ? SIZES.find(s => s > it.s) : [...SIZES].reverse().find(s => s < it.s);
    if (next == null) return;
    const before = this.editing ? null : this.snap(t.pid);
    it.s = next;
    this.tools.text.size = next; // 다음에 만드는 글자도 같은 크기로
    this.saveTools();
    t.el.style.fontSize = next * this.scale + 'px';
    this.root.querySelector('.selbar .size-val').textContent = next;
    if (before) this.commit(t.pid, before); else this.scheduleSave();
    this.positionSelection();
  }

  positionSelection() {
    const bar = this.root.querySelector('.selbar');
    const target = this.barTarget();
    if (!target || !target.el.isConnected) { bar.hidden = true; return; }
    const r = target.el.getBoundingClientRect();
    const rr = this.root.getBoundingClientRect();
    bar.style.left = clamp(r.left - rr.left, 8, rr.width - 300) + 'px';
    bar.style.top = Math.max(r.top - rr.top - 48, 60) + 'px';
  }

  // ---------- 올가미 선택 ----------
  drawLassoPath() {
    const a = this.active;
    if (!a || !a.live) return;
    const ctx = a.live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, a.live.width, a.live.height);
    ctx.setTransform(a.live._rs, 0, 0, a.live._rs, 0, 0);
    const p = a.path;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(232,87,74,0.06)';
    ctx.fill();
    ctx.setLineDash([5 / this.scale * 1.5, 4 / this.scale * 1.5]);
    ctx.lineWidth = 1.5 / this.scale;
    ctx.strokeStyle = '#e8574a';
    ctx.stroke();
  }

  lassoSelect(pid, path) {
    const pi = this.ink[pid];
    if (!pi || path.length < 6) return;
    const strokes = new Set(), texts = new Set(), images = new Set();
    for (const s of pi.strokes) {
      const n = s.p.length / 3;
      let inside = 0;
      for (let i = 0; i < n; i++) if (inPoly(s.p[i * 3], s.p[i * 3 + 1], path)) inside++;
      if (inside && inside >= n * 0.5) strokes.add(s.id);
    }
    const el = this.pageEls.get(pid);
    for (const t of pi.texts) {
      const d = el.querySelector(`[data-id="${t.id}"]`);
      const h = d ? d.offsetHeight / this.scale : t.s * 1.3;
      if (inPoly(t.x + t.w / 2, t.y + h / 2, path) || inPoly(t.x + 4, t.y + h / 2, path)) texts.add(t.id);
    }
    for (const im of pi.images) if (inPoly(im.x + im.w / 2, im.y + im.h / 2, path)) images.add(im.id);
    if (!strokes.size && !texts.size && !images.size) return;
    this.lassoSel = { pid, strokes, texts, images, box: null };
    this.updateLassoBox();
  }

  lassoItems() {
    const L = this.lassoSel;
    const pi = this.ink[L.pid] || emptyPage();
    return {
      strokes: pi.strokes.filter(s => L.strokes.has(s.id)),
      texts: pi.texts.filter(t => L.texts.has(t.id)),
      images: pi.images.filter(m => L.images.has(m.id)),
    };
  }

  lassoClone() { return JSON.parse(JSON.stringify(this.lassoItems())); }

  computeLassoBox() {
    const { strokes, texts, images } = this.lassoItems();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (ax, ay, bx, by) => { x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, bx); y1 = Math.max(y1, by); };
    for (const s of strokes) for (let i = 0; i < s.p.length; i += 3) add(s.p[i] - s.w / 2, s.p[i + 1] - s.w / 2, s.p[i] + s.w / 2, s.p[i + 1] + s.w / 2);
    const el = this.pageEls.get(this.lassoSel.pid);
    for (const t of texts) {
      const d = el.querySelector(`[data-id="${t.id}"]`);
      add(t.x, t.y, t.x + t.w, t.y + (d ? d.offsetHeight / this.scale : t.s * 1.3));
    }
    for (const m of images) add(m.x, m.y, m.x + m.w, m.y + m.h);
    if (x0 === Infinity) return null;
    const pad = 6;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  updateLassoBox() {
    const L = this.lassoSel;
    const bar = this.root.querySelector('.lassobar');
    if (!L) { bar.hidden = true; return; }
    L.box = this.computeLassoBox();
    if (!L.box) return this.clearLasso();
    const el = this.pageEls.get(L.pid);
    let box = el.querySelector('.lasso-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'lasso-box';
      box.innerHTML = '<div class="lasso-handle"></div>';
      el.appendChild(box);
    }
    const s = this.scale;
    Object.assign(box.style, { left: L.box.x * s + 'px', top: L.box.y * s + 'px', width: L.box.w * s + 'px', height: L.box.h * s + 'px' });
    const n = L.strokes.size + L.texts.size + L.images.size;
    bar.querySelector('.lasso-count').textContent = `${n}개 선택`;
    bar.hidden = false;
    this.updatePastePill();
    this.positionLassoBar();
  }

  positionLassoBar() {
    const L = this.lassoSel;
    const bar = this.root.querySelector('.lassobar');
    if (!L) return;
    const box = this.pageEls.get(L.pid).querySelector('.lasso-box');
    if (!box) return;
    const r = box.getBoundingClientRect();
    const rr = this.root.getBoundingClientRect();
    bar.style.left = clamp(r.left - rr.left, 8, Math.max(8, rr.width - bar.offsetWidth - 8)) + 'px';
    const above = r.top - rr.top - bar.offsetHeight - 10;
    bar.style.top = (above > 60 ? above : Math.min(r.bottom - rr.top + 10, rr.height - bar.offsetHeight - 50)) + 'px';
  }

  clearLasso() {
    const L = this.lassoSel;
    if (!L) return;
    const el = this.pageEls.get(L.pid);
    const box = el && el.querySelector('.lasso-box');
    if (box) box.remove();
    this.lassoSel = null;
    this.root.querySelector('.lassobar').hidden = true;
    this.updatePastePill();
  }

  // 이동(dx,dy) 또는 크기 조절(오른쪽 아래 손잡이)을 원본 복사본 기준으로 적용
  lassoTransform(a, dx, dy) {
    const cur = this.lassoItems();
    const o = a.orig;
    let fx, k = 1;
    if (a.kind === 'lasso-move') {
      fx = (x, y) => [r1(x + dx), r1(y + dy)];
    } else {
      const b = a.box0;
      k = Math.max(0.15, (b.w + dx) / b.w);
      fx = (x, y) => [r1(b.x + (x - b.x) * k), r1(b.y + (y - b.y) * k)];
    }
    cur.strokes.forEach((s, i) => {
      const src = o.strokes[i];
      const p = src.p.slice();
      for (let j = 0; j < p.length; j += 3) { const [nx, ny] = fx(p[j], p[j + 1]); p[j] = nx; p[j + 1] = ny; }
      s.p = p;
      s.w = r1(src.w * k) || src.w;
    });
    cur.texts.forEach((t, i) => {
      const src = o.texts[i];
      [t.x, t.y] = fx(src.x, src.y);
      t.s = Math.max(4, Math.round(src.s * k * 10) / 10);
      t.w = r1(src.w * k);
    });
    cur.images.forEach((m, i) => {
      const src = o.images[i];
      [m.x, m.y] = fx(src.x, src.y);
      m.w = r1(src.w * k);
      m.h = r1(src.h * k);
    });
    if (!a.raf) a.raf = requestAnimationFrame(() => {
      a.raf = 0;
      this.drawInkCanvas(a.pageEl, this.pageOf(a.pid));
      this.renderItems(a.pid);
      this.updateLassoBox();
    });
  }

  lassoColor(color) {
    const L = this.lassoSel;
    if (!L) return;
    const before = this.snap(L.pid);
    const { strokes, texts } = this.lassoItems();
    strokes.forEach(s => { if (s.t !== 'hl') s.c = color; });
    texts.forEach(t => { t.c = color; });
    this.refreshPage(L.pid);
    this.commit(L.pid, before);
  }

  lassoDuplicate() {
    const L = this.lassoSel;
    if (!L) return;
    const before = this.snap(L.pid);
    const pi = this.pageInk(L.pid);
    const copy = this.lassoClone();
    const off = 20;
    const strokes = new Set(), texts = new Set(), images = new Set();
    copy.strokes.forEach(s => { s.id = uid(); for (let j = 0; j < s.p.length; j += 3) { s.p[j] += off; s.p[j + 1] += off; } pi.strokes.push(s); strokes.add(s.id); });
    copy.texts.forEach(t => { t.id = uid(); t.x += off; t.y += off; pi.texts.push(t); texts.add(t.id); });
    copy.images.forEach(m => { m.id = uid(); m.x += off; m.y += off; pi.images.push(m); images.add(m.id); });
    this.lassoSel = { pid: L.pid, strokes, texts, images, box: null };
    this.refreshPage(L.pid);
    this.updateLassoBox();
    this.commit(L.pid, before);
  }

  // ---------- 복사 / 잘라내기 / 붙여넣기 (다른 페이지·다른 노트로도 가능) ----------
  getClip() {
    if (this.clip) return this.clip;
    try { this.clip = JSON.parse(localStorage.getItem('godnote.clip')); } catch {}
    return this.clip;
  }

  lassoCopy(cut) {
    const L = this.lassoSel;
    if (!L || !L.box) return;
    const items = this.lassoClone();
    const { x, y, w, h } = L.box;
    // 상자 왼쪽 위를 (0,0) 으로 맞춰 저장
    items.strokes.forEach(s => { for (let j = 0; j < s.p.length; j += 3) { s.p[j] = r1(s.p[j] - x); s.p[j + 1] = r1(s.p[j + 1] - y); } });
    items.texts.forEach(t => { t.x = r1(t.x - x); t.y = r1(t.y - y); });
    items.images.forEach(m => { m.x = r1(m.x - x); m.y = r1(m.y - y); });
    this.clip = Object.assign(items, { w, h });
    try { localStorage.setItem('godnote.clip', JSON.stringify(this.clip)); } catch { localStorage.removeItem('godnote.clip'); }
    if (cut) { this.lassoDelete(); this.toast('잘라냈습니다 — 붙여넣을 페이지에서 붙여넣기를 누르세요'); }
    else this.toast('복사했습니다');
    this.updatePastePill();
  }

  lassoPaste() {
    const clip = this.getClip();
    if (!clip || !this.note) return;
    const pid = this.currentPageId();
    const pg = this.pageOf(pid);
    const el = this.pageEls.get(pid);
    const s = this.scale;
    const visTop = (this.scroller.scrollTop - el.offsetTop) / s;
    const visH = this.scroller.clientHeight / s;
    const cy = clamp(visTop + visH / 2, 0, pg.h);
    const ox = r1(clamp(pg.w / 2 - clip.w / 2, 0, Math.max(0, pg.w - clip.w)));
    const oy = r1(clamp(cy - clip.h / 2, 0, Math.max(0, pg.h - clip.h)));
    const before = this.snap(pid);
    const pi = this.pageInk(pid);
    const c = JSON.parse(JSON.stringify(clip));
    const strokes = new Set(), texts = new Set(), images = new Set();
    c.strokes.forEach(st => { st.id = uid(); for (let j = 0; j < st.p.length; j += 3) { st.p[j] = r1(st.p[j] + ox); st.p[j + 1] = r1(st.p[j + 1] + oy); } pi.strokes.push(st); strokes.add(st.id); });
    c.texts.forEach(t => { t.id = uid(); t.x = r1(t.x + ox); t.y = r1(t.y + oy); pi.texts.push(t); texts.add(t.id); });
    c.images.forEach(m => { m.id = uid(); m.x = r1(m.x + ox); m.y = r1(m.y + oy); pi.images.push(m); images.add(m.id); });
    if (this.tools.tool !== 'lasso') this.setTool('lasso');
    this.clearLasso();
    this.refreshPage(pid);
    this.lassoSel = { pid, strokes, texts, images, box: null };
    this.updateLassoBox();
    this.commit(pid, before);
    this.updatePastePill();
  }

  // 올가미 도구에서 아무것도 안 골랐을 때 '붙여넣기' 버튼 표시
  updatePastePill() {
    const pill = this.root.querySelector('.paste-pill');
    if (!pill) return;
    pill.hidden = !(this.tools.tool === 'lasso' && !this.lassoSel && this.getClip() && this.root.dataset.ui !== 'hidden');
  }

  lassoDelete() {
    const L = this.lassoSel;
    if (!L) return;
    const before = this.snap(L.pid);
    const pi = this.pageInk(L.pid);
    pi.strokes = pi.strokes.filter(s => !L.strokes.has(s.id));
    pi.texts = pi.texts.filter(t => !L.texts.has(t.id));
    pi.images = pi.images.filter(m => !L.images.has(m.id));
    const pid = L.pid;
    this.clearLasso();
    this.refreshPage(pid);
    this.commit(pid, before);
  }

  deleteSelected() {
    if (!this.selected && this.editing) {
      // 입력 중인 글자 상자 삭제: 내용을 비우고 편집을 끝내면 지워짐
      this.editing.el.textContent = '';
      this.finishEditing();
      return;
    }
    if (!this.selected) return;
    const { pid, id } = this.selected;
    const before = this.snap(pid);
    const pi = this.pageInk(pid);
    pi.texts = pi.texts.filter(t => t.id !== id);
    pi.images = pi.images.filter(t => t.id !== id);
    this.deselect();
    this.renderItems(pid);
    this.commit(pid, before);
  }

  editText(pid, id) {
    this.deselect();
    const el = this.pageEls.get(pid).querySelector(`[data-id="${id}"]`);
    if (!el) return;
    const before = this.snap(pid);
    el.classList.add('editing');
    this.editing = { pid, id, el, kind: 'text' };
    try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // 입력하는 동안에도 자동 저장 (편집을 끝내지 않아도 저장됨)
    const onInput = () => {
      const t = this.pageInk(pid).texts.find(x => x.id === id);
      if (t) { t.text = el.innerText.replace(/\n$/, ''); this.scheduleSave(); }
    };
    el.addEventListener('input', onInput);
    this.showSelbar();
    const done = () => {
      if (el._done !== done) return;
      el._done = null;
      el.removeEventListener('blur', done);
      el.removeEventListener('input', onInput);
      if (this.editing && this.editing.el === el) this.editing = null;
      if (!this.selected) this.root.querySelector('.selbar').hidden = true;
      el.contentEditable = 'false';
      el.classList.remove('editing');
      const pi = this.pageInk(pid);
      const t = pi.texts.find(x => x.id === id);
      const text = el.innerText.replace(/\n$/, '');
      if (t) {
        if (!text.trim()) pi.texts = pi.texts.filter(x => x !== t);
        else t.text = text;
      }
      this.renderItems(pid);
      this.commit(pid, before);
    };
    el._done = done;
    el.addEventListener('blur', done);
  }

  // 편집 중인 글자 상자를 확실히 마무리 (포커스가 없어 blur 가 안 오는 경우 대비)
  finishEditing() {
    const ed = this.editing;
    if (!ed) return;
    if (ed.el._done) ed.el._done();
    if (document.activeElement === ed.el) ed.el.blur();
  }

  addText(pid, x, y) {
    const pg = this.pageOf(pid);
    const pi = this.pageInk(pid);
    const size = this.tools.text.size;
    const t = { id: uid(), x: r1(x), y: r1(y - size * 0.7), w: r1(Math.max(80, Math.min(320, pg.w - x - 10))), s: size, c: this.tools.pen.color, text: '' };
    pi.texts.push(t);
    this.renderItems(pid);
    this.editText(pid, t.id);
  }

  async addImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const src = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    // 동기화 용량을 줄이기 위해 최대 1600px 로 축소
    const maxSide = 1600;
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const data = file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
    const pid = this.currentPageId();
    const pg = this.pageOf(pid);
    const w = pg.w * 0.5;
    const h = w * c.height / c.width;
    // 현재 화면에 보이는 위치 근처에 넣기
    const el = this.pageEls.get(pid);
    const visibleTop = (this.scroller.scrollTop - el.offsetTop) / this.scale;
    const y = clamp(visibleTop + 80, 20, Math.max(20, pg.h - h - 20));
    const before = this.snap(pid);
    const im = { id: uid(), x: r1((pg.w - w) / 2), y: r1(y), w: r1(w), h: r1(h), src: data };
    this.pageInk(pid).images.push(im);
    this.renderItems(pid);
    this.commit(pid, before);
    this.setTool('select');
    this.select(pid, im.id);
  }

  // ---------- 입력 처리 ----------
  pagePoint(el, e) {
    const r = el.getBoundingClientRect();
    const s = this.scale;
    return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
  }

  bindUi() {
    const sc = this.scroller;
    sc.addEventListener('pointerdown', e => this.onDown(e));
    sc.addEventListener('pointermove', e => this.onMove(e));
    sc.addEventListener('pointerup', e => this.onUp(e));
    sc.addEventListener('pointercancel', e => this.onUp(e, true));
    sc.addEventListener('dblclick', e => {
      const item = e.target.closest('.item.text');
      if (item && this.tools.tool === 'select') this.editText(item.closest('.page').dataset.pid, item.dataset.id);
    });
    sc.addEventListener('scroll', () => {
      this.updatePageLabel();
      this.positionSelection();
      this.positionLassoBar();
      if (this.note && this.note.pages.length) {
        this.note.lastPage = this.currentPageId();
        if (this.panel) this.panel.highlight(this.currentIndex());
      }
    }, { passive: true });
    // iPad 사파리에서 펜으로 쓸 때 화면이 끌려가거나 돋보기가 뜨는 것을 막음
    sc.addEventListener('touchmove', e => { if (this.active) e.preventDefault(); }, { passive: false });
    sc.addEventListener('touchstart', e => {
      if (!this.tools.penOnly) return;
      const fingers = [...e.touches].filter(t => t.touchType !== 'stylus');
      const onlyFingers = [...e.changedTouches].every(t => t.touchType !== 'stylus');
      const writing = (this.active && this.active.ptype === 'pen') || Date.now() - this.lastPenAt < 1000;
      if (writing && onlyFingers && fingers.length === 1) e.preventDefault();
    }, { passive: false });
    let tap = null;
    sc.addEventListener('touchstart', e => {
      const all = [...e.touches];
      if (all.some(t => t.touchType === 'stylus')) { tap = null; return; }
      if (!tap) tap = { t0: Date.now(), max: 0, pts: {}, moved: false };
      for (const t of e.changedTouches) tap.pts[t.identifier] = [t.clientX, t.clientY];
      tap.max = Math.max(tap.max, all.length);
      // 손가락 필기 중 두 번째 손가락이 닿으면 그 획은 취소
      if (all.length >= 2 && this.active && this.active.ptype === 'touch') this.abortActive();
    }, { passive: true });
    sc.addEventListener('touchmove', e => {
      if (!tap) return;
      for (const t of e.changedTouches) {
        const p = tap.pts[t.identifier];
        if (p && Math.hypot(t.clientX - p[0], t.clientY - p[1]) > 14) tap.moved = true;
      }
    }, { passive: true });
    sc.addEventListener('touchend', e => {
      if (!tap || e.touches.length) return;
      const t = tap;
      tap = null;
      if (t.moved || t.max < 2 || Date.now() - t.t0 > 350) return;
      if (Date.now() - this.lastPenAt < 500) return; // 펜슬로 쓰는 중 손바닥이 닿은 경우
      if (t.max === 2) { if (this.undoStack.length) { this.undo(); this.toast('실행 취소', 900); } }
      else if (this.redoStack.length) { this.redo(); this.toast('다시 실행', 900); }
    });
    sc.addEventListener('touchcancel', () => { tap = null; });

    // 맥 트랙패드 핀치 / ctrl+휠 확대
    sc.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01));
    }, { passive: false });
    // iPad 두 손가락 핀치 (사파리 gesture 이벤트)
    let gz = 1;
    sc.addEventListener('gesturestart', e => { e.preventDefault(); gz = this.zoom; });
    sc.addEventListener('gesturechange', e => {
      e.preventDefault();
      if (tap) tap.moved = true;
      this.inner.style.transformOrigin = `50% ${sc.scrollTop + sc.clientHeight / 2}px`;
      this.inner.style.transform = `scale(${clamp(gz * e.scale, 0.5, 4) / this.zoom})`;
    });
    sc.addEventListener('gestureend', e => {
      e.preventDefault();
      this.inner.style.transform = '';
      this.setZoom(gz * e.scale);
    });

    const R = this.root;
    R.querySelector('[data-act="back"]').onclick = () => this.close();
    R.querySelector('[data-act="undo"]').onclick = () => this.undo();
    R.querySelector('[data-act="redo"]').onclick = () => this.redo();
    R.querySelector('[data-act="zoom-in"]').onclick = () => this.setZoom(this.zoom * 1.25);
    R.querySelector('[data-act="zoom-out"]').onclick = () => this.setZoom(this.zoom / 1.25);
    R.querySelector('.zoom-label').onclick = () => this.setZoom(1);
    R.querySelectorAll('[data-tool]').forEach(b => {
      b.onclick = () => {
        if (b.dataset.tool === 'image') return R.querySelector('#image-input').click();
        if (this.tools.tool === b.dataset.tool) this.toggleOptions();
        else this.setTool(b.dataset.tool);
      };
    });
    R.querySelector('#image-input').onchange = e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.addImage(f).catch(err => this.toast('이미지를 넣지 못했습니다: ' + err.message));
    };
    R.querySelector('[data-act="pen-only"]').onclick = () => {
      this.tools.penOnly = !this.tools.penOnly;
      this.saveTools();
      this.updateUi();
      this.toast(this.tools.penOnly ? '애플펜슬로만 필기 (손가락은 스크롤)' : '손가락으로도 필기');
    };
    R.querySelector('[data-act="add-page"]').onclick = () => this.addPage();
    R.querySelector('[data-act="del-page"]').onclick = () => this.deletePage();
    R.querySelector('[data-act="rename"]').onclick = () => this.rename();
    R.querySelector('[data-act="more"]').onclick = e => {
      e.stopPropagation();
      R.querySelector('.more-menu').hidden = !R.querySelector('.more-menu').hidden;
    };
    document.addEventListener('pointerdown', e => {
      const m = R.querySelector('.more-menu');
      if (!m.hidden && !e.target.closest('.more-menu') && !e.target.closest('[data-act="more"]')) m.hidden = true;
      const o = R.querySelector('.tool-options');
      if (!o.hidden && !e.target.closest('.tool-options') && !e.target.closest('[data-tool]')) o.hidden = true;
    });
    const bar = R.querySelector('.selbar');
    bar.querySelector('[data-act="delete"]').onclick = () => this.deleteSelected();
    bar.querySelector('[data-act="edit"]').onclick = () => { const s = this.selected; if (s) this.editText(s.pid, s.id); };
    bar.querySelector('[data-act="size-up"]').onclick = () => this.changeTextSize(1);
    bar.querySelector('[data-act="size-down"]').onclick = () => this.changeTextSize(-1);
    // 텍스트를 입력하는 중에 버튼을 눌러도 입력 상태가 풀리지 않게 함
    bar.addEventListener('pointerdown', e => { if (this.editing) e.preventDefault(); });
    bar.addEventListener('mousedown', e => { if (this.editing) e.preventDefault(); });
    R.querySelector('[data-act="hide-ui"]').onclick = () => this.setUiHidden(true);
    const lb = R.querySelector('.lassobar');
    lb.querySelectorAll('[data-lcolor]').forEach(b => { b.onclick = () => this.lassoColor(b.dataset.lcolor); });
    lb.querySelector('[data-act="lasso-dup"]').onclick = () => this.lassoDuplicate();
    lb.querySelector('[data-act="lasso-copy"]').onclick = () => this.lassoCopy(false);
    lb.querySelector('[data-act="lasso-cut"]').onclick = () => this.lassoCopy(true);
    R.querySelector('.paste-pill').onclick = () => this.lassoPaste();
    R.querySelector('[data-act="paste"]').onclick = () => {
      R.querySelector('.more-menu').hidden = true;
      if (!this.getClip()) return this.toast('올가미로 고른 뒤 복사하거나 잘라낸 내용이 없습니다');
      this.lassoPaste();
    };
    lb.querySelector('[data-act="lasso-del"]').onclick = () => this.lassoDelete();
    R.querySelector('[data-act="export"]').onclick = async () => {
      R.querySelector('.more-menu').hidden = true;
      this.finishEditing();
      await this.flush();
      this.onExport(this.note.id);
    };
    R.querySelector('[data-act="show-ui"]').onclick = () => this.setUiHidden(false);
    R.querySelector('[data-act="undo-float"]').onclick = () => this.undo();

    document.addEventListener('keydown', e => {
      if (!this.note || this.root.hidden) return;
      const editing = document.activeElement && (document.activeElement.isContentEditable || /INPUT|TEXTAREA/.test(document.activeElement.tagName));
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !editing) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (mod && e.key.toLowerCase() === 'y' && !editing) { e.preventDefault(); this.redo(); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && this.selected && !editing) { e.preventDefault(); this.deleteSelected(); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && this.lassoSel && !editing) { e.preventDefault(); this.lassoDelete(); }
      else if (mod && e.key === 'f') { e.preventDefault(); this.search.toggle(true); }
      else if (mod && !editing && this.lassoSel && (e.key === 'c' || e.key === 'x')) { e.preventDefault(); this.lassoCopy(e.key === 'x'); }
      else if (mod && !editing && e.key === 'v' && this.getClip()) {
        // 이미지 붙여넣기(paste 이벤트)가 먼저 처리되면 필기 붙여넣기는 하지 않음
        this._imagePasted = false;
        setTimeout(() => { if (!this._imagePasted) this.lassoPaste(); }, 60);
      }
      else if (e.key === 'Escape') { if (editing) document.activeElement.blur(); this.deselect(); this.clearLasso(); }
      else if (!editing && !mod) {
        const map = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', t: 'text', v: 'select' };
        if (map[e.key]) this.setTool(map[e.key]);
        else if (e.key === 'f') this.setUiHidden(this.root.dataset.ui !== 'hidden');
      }
    });
    document.addEventListener('paste', e => {
      if (!this.note || this.root.hidden) return;
      const f = [...(e.clipboardData && e.clipboardData.files || [])].find(f => f.type.startsWith('image/'));
      if (f) { e.preventDefault(); this._imagePasted = true; this.addImage(f); }
    });
    this.buildOptions();
  }

  onDown(e) {
    if (e.pointerType === 'pen') this.lastPenAt = Date.now();
    // 펜슬 전용: 손가락·손바닥으로는 아무것도 쓰거나 고르지 않음 (스크롤·확대만)
    if (this.tools.penOnly && e.pointerType === 'touch') return;
    this._onDown(e);
    if (this.active && !this.active.ptype) this.active.ptype = e.pointerType;
  }

  // 진행 중인 동작을 저장하지 않고 취소 (두 손가락 탭 등)
  abortActive() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    clearTimeout(a.holdTimer);
    if (a.raf) cancelAnimationFrame(a.raf);
    if (a.live) a.live.remove();
    if (a.before && a.kind !== 'stroke') {
      this.ink[a.pid] = this.unsnap(a.before);
      this.refreshPage(a.pid);
    }
  }

  _onDown(e) {
    const pageEl = e.target.closest('.page');
    if (!pageEl || !this.note) return;
    if (e.pointerType === 'pen' && !this.tools.penOnly && !this.tools.penSeen) {
      // 애플펜슬을 처음 쓰면 손가락은 스크롤용으로 자동 전환
      this.tools.penSeen = true;
      this.tools.penOnly = true;
      this.saveTools();
      this.updateUi();
      this.toast('애플펜슬 감지: 손가락은 스크롤, 펜슬로 필기합니다');
    }
    const tool = this.tools.tool;
    const pid = pageEl.dataset.pid;
    if (this.active) return;
    if (e.button && e.button !== 0) return;

    if (tool === 'select') {
      const item = e.target.closest('.item');
      if (!item) { this.deselect(); return; }
      if (item.classList.contains('editing')) return;
      e.preventDefault();
      if (!this.selected || this.selected.id !== item.dataset.id) this.select(pid, item.dataset.id);
      const it = this.findItem(pid, item.dataset.id);
      const [x, y] = this.pagePoint(pageEl, e);
      const r = item.getBoundingClientRect();
      const nearCorner = e.clientX > r.right - 28 && e.clientY > r.bottom - 28;
      this.active = { kind: nearCorner ? 'resize' : 'move', pid, pageEl, it, x0: x, y0: y, orig: Object.assign({}, it), before: this.snap(pid), id: e.pointerId };
      try { this.scroller.setPointerCapture(e.pointerId); } catch {}
      return;
    }

    if (tool === 'lasso') {
      // 선택 상자 안을 누르면 이동/크기 조절 (손가락으로도 가능)
      const boxEl = e.target.closest('.lasso-box');
      if (boxEl && this.lassoSel && this.lassoSel.pid === pid) {
        e.preventDefault();
        const [x, y] = this.pagePoint(pageEl, e);
        const handle = !!e.target.closest('.lasso-handle');
        this.active = { kind: handle ? 'lasso-resize' : 'lasso-move', pid, pageEl, x0: x, y0: y, orig: this.lassoClone(), box0: Object.assign({}, this.lassoSel.box), before: this.snap(pid), id: e.pointerId };
        try { this.scroller.setPointerCapture(e.pointerId); } catch {}
        return;
      }
      if (this.tools.penOnly && e.pointerType === 'touch') return;
      e.preventDefault();
      this.finishEditing();
      this.clearLasso();
      try { this.scroller.setPointerCapture(e.pointerId); } catch {}
      const [x, y] = this.pagePoint(pageEl, e);
      this.active = { kind: 'lasso', pid, pageEl, live: this.attachLive(pageEl), path: [x, y], id: e.pointerId };
      return;
    }

    const touchBlocked = this.tools.penOnly && e.pointerType === 'touch';
    if (touchBlocked) return;

    if (tool === 'text') {
      const item = e.target.closest('.item.text');
      if (item && item.classList.contains('editing')) return;
      e.preventDefault();
      if (this.editing) { this.finishEditing(); return; }
      if (item) return this.editText(pid, item.dataset.id);
      const [x, y] = this.pagePoint(pageEl, e);
      return this.addText(pid, x, y);
    }

    if (tool === 'pen' || tool === 'hl' || tool === 'eraser') {
      e.preventDefault();
      this.finishEditing();
      this.deselect();
      try { this.scroller.setPointerCapture(e.pointerId); } catch {}
      const live = this.attachLive(pageEl, tool === 'hl');
      const [x, y] = this.pagePoint(pageEl, e);
      if (tool === 'eraser') {
        this.active = { kind: 'erase', pid, pageEl, live, before: this.snap(pid), lx: x, ly: y, id: e.pointerId };
        this.eraseAt(x, y, x, y);
        this.drawEraserCursor(x, y);
      } else {
        const opt = tool === 'hl' ? this.tools.hl : this.tools.pen;
        const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
        const stroke = { id: uid(), t: tool === 'hl' ? 'hl' : 'pen', c: opt.color, w: opt.width, p: [r1(x), r1(y), Math.round(pr * 100) / 100] };
        this.active = { kind: 'stroke', pid, pageEl, live, stroke, before: this.snap(pid), id: e.pointerId, pen: e.pointerType === 'pen' };
        this.drawLive();
      }
    }
  }

  onMove(e) {
    if (e.pointerType === 'pen') this.lastPenAt = Date.now();
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    e.preventDefault();
    if (a.kind === 'stroke') {
      if (a.snapped) {
        // 직선으로 바뀐 뒤에도 펜을 떼기 전까지는 끝점을 따라 움직임
        if (a.snapLine) {
          const [x, y] = this.pagePoint(a.pageEl, e);
          const p = a.stroke.p;
          p[3] = r1(a.snapLine.lock === 'v' ? p[0] : x);
          p[4] = r1(a.snapLine.lock === 'h' ? p[1] : y);
          if (!a.raf) a.raf = requestAnimationFrame(() => { a.raf = 0; this.drawLive(); });
        }
        return;
      }
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const p = a.stroke.p;
      for (const ev of (evs.length ? evs : [e])) {
        const [x, y] = this.pagePoint(a.pageEl, ev);
        const lx = p[p.length - 3], ly = p[p.length - 2];
        if (Math.abs(x - lx) + Math.abs(y - ly) < 0.6) continue;
        const pr = a.pen ? (ev.pressure || 0.5) : 0.5;
        p.push(r1(x), r1(y), Math.round(pr * 100) / 100);
      }
      if (!a.raf) a.raf = requestAnimationFrame(() => { a.raf = 0; this.drawLive(); });
      // 펜이 한 자리에 잠깐 머물면 보정: 형광펜은 직선, 펜은 직선·원·사각형
      const isHl = a.stroke.t === 'hl';
      if (isHl ? this.tools.hlStraight : this.tools.shapeSnap) {
        const lx = p[p.length - 3], ly = p[p.length - 2];
        const tol = 6 / this.scale;
        if (a.holdX == null || Math.hypot(lx - a.holdX, ly - a.holdY) > tol) {
          a.holdX = lx; a.holdY = ly;
          clearTimeout(a.holdTimer);
          a.holdTimer = setTimeout(() => this.trySnap(a), isHl ? HL_HOLD_MS : PEN_HOLD_MS);
        }
      }
    } else if (a.kind === 'erase') {
      const [x, y] = this.pagePoint(a.pageEl, e);
      if (this.eraseAt(x, y, a.lx, a.ly)) this.drawInkCanvas(a.pageEl, this.pageOf(a.pid));
      a.lx = x; a.ly = y;
      this.drawEraserCursor(x, y);
    } else if (a.kind === 'lasso') {
      const [x, y] = this.pagePoint(a.pageEl, e);
      const p = a.path;
      if (Math.abs(x - p[p.length - 2]) + Math.abs(y - p[p.length - 1]) > 2) p.push(r1(x), r1(y));
      if (!a.raf) a.raf = requestAnimationFrame(() => { a.raf = 0; this.drawLassoPath(); });
    } else if (a.kind === 'lasso-move' || a.kind === 'lasso-resize') {
      const [x, y] = this.pagePoint(a.pageEl, e);
      this.lassoTransform(a, x - a.x0, y - a.y0);
    } else if (a.kind === 'move' || a.kind === 'resize') {
      const [x, y] = this.pagePoint(a.pageEl, e);
      const dx = x - a.x0, dy = y - a.y0;
      const it = a.it;
      if (a.kind === 'move') {
        it.x = r1(a.orig.x + dx);
        it.y = r1(a.orig.y + dy);
      } else if (a.orig.h != null) {
        const w = Math.max(20, a.orig.w + dx);
        it.w = r1(w);
        it.h = r1(w * a.orig.h / a.orig.w);
      } else {
        it.w = r1(Math.max(40, a.orig.w + dx));
      }
      this.renderItems(a.pid);
    }
  }

  trySnap(a) {
    if (this.active !== a || a.snapped) return;
    const shape = a.stroke.t === 'hl' ? straightLine(a.stroke.p) : recognizeShape(a.stroke.p);
    if (!shape) return;
    a.stroke.p = shape.p;
    a.stroke.k = 'poly';
    if (shape.closed) a.stroke.closed = true;
    else a.snapLine = { lock: shape.lock || null };
    a.snapped = true;
    this.drawLive();
  }

  onUp(e, cancelled) {
    if (e.pointerType === 'pen') this.lastPenAt = Date.now();
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    clearTimeout(a.holdTimer);
    this.active = null;
    if (a.raf) cancelAnimationFrame(a.raf);
    if (a.live) a.live.remove();
    if (a.kind === 'stroke') {
      if (!cancelled || a.stroke.p.length > 6) {
        this.pageInk(a.pid).strokes.push(a.stroke);
        this.drawInkCanvas(a.pageEl, this.pageOf(a.pid));
        this.commit(a.pid, a.before);
      }
    } else if (a.kind === 'erase') {
      this.commit(a.pid, a.before);
    } else if (a.kind === 'lasso') {
      this.lassoSelect(a.pid, a.path);
    } else if (a.kind === 'lasso-move' || a.kind === 'lasso-resize') {
      this.drawInkCanvas(a.pageEl, this.pageOf(a.pid));
      this.commit(a.pid, a.before);
      this.updateLassoBox();
    } else {
      this.commit(a.pid, a.before);
    }
  }

  attachLive(pageEl, hl) {
    const c = document.createElement('canvas');
    c.className = hl ? 'live hl' : 'live';
    const rs = pageEl._rs || this.renderScale(this.pageOf(pageEl.dataset.pid));
    const pg = this.pageOf(pageEl.dataset.pid);
    c.width = Math.round(pg.w * rs);
    c.height = Math.round(pg.h * rs);
    c._rs = rs;
    pageEl.appendChild(c);
    return c;
  }

  drawLive() {
    const a = this.active;
    if (!a || !a.live) return;
    const ctx = a.live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, a.live.width, a.live.height);
    ctx.setTransform(a.live._rs, 0, 0, a.live._rs, 0, 0);
    drawStroke(ctx, a.stroke);
  }

  drawEraserCursor(x, y) {
    const a = this.active;
    const ctx = a.live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, a.live.width, a.live.height);
    ctx.setTransform(a.live._rs, 0, 0, a.live._rs, 0, 0);
    ctx.beginPath();
    ctx.arc(x, y, this.tools.eraser.size, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,120,120,0.12)';
    ctx.strokeStyle = 'rgba(80,80,80,0.6)';
    ctx.lineWidth = 1 / this.scale;
    ctx.fill();
    ctx.stroke();
  }

  // 지우개: (lx,ly)→(x,y) 이동 경로에 닿은 필기를 지움. 변경 여부 반환
  eraseAt(x, y, lx, ly) {
    const pi = this.ink[this.active.pid];
    if (!pi || !pi.strokes.length) return false;
    const r = this.tools.eraser.size;
    const partial = this.tools.eraser.mode === 'partial';
    let changed = false;
    const out = [];
    for (const s of pi.strokes) {
      let p = s.p, n = p.length / 3;
      const reach = r + s.w / 2;
      // 빠른 배제: 경계 상자
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const px = p[i * 3], py = p[i * 3 + 1];
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
      if (Math.max(x, lx) < minX - reach || Math.min(x, lx) > maxX + reach || Math.max(y, ly) < minY - reach || Math.min(y, ly) > maxY + reach) {
        out.push(s);
        continue;
      }
      // 직선·도형은 꼭짓점만 있으므로 촘촘한 점으로 바꿔서 판단 (가운데도 지워지게)
      if (s.k === 'poly' && partial) { p = densify(s); n = p.length / 3; }
      const hit = new Uint8Array(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        if (distToSeg(p[i * 3], p[i * 3 + 1], lx, ly, x, y) <= reach) { hit[i] = 1; any = true; }
      }
      if (!any && !partial) {
        for (let i = 0; i < n - 1 && !any; i++) {
          if (distToSeg(x, y, p[i * 3], p[i * 3 + 1], p[i * 3 + 3], p[i * 3 + 4]) <= reach) any = true;
        }
        if (!any && s.closed && n > 2 && distToSeg(x, y, p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[0], p[1]) <= reach) any = true;
      }
      if (!any) { out.push(s); continue; }
      changed = true;
      if (!partial) continue;
      // 닿은 점을 기준으로 획을 잘라 남은 부분만 유지
      let run = [];
      const flushRun = () => {
        if (run.length >= 6) out.push({ id: uid(), t: s.t, c: s.c, w: s.w, p: run });
        run = [];
      };
      for (let i = 0; i < n; i++) {
        if (hit[i]) flushRun();
        else run.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      }
      flushRun();
    }
    if (changed) pi.strokes = out;
    return changed;
  }

  // ---------- 도구 UI ----------
  saveTools() { localStorage.setItem(LS_TOOLS, JSON.stringify(this.tools)); }

  setTool(t) {
    this.finishEditing();
    if (t !== 'lasso') this.clearLasso();
    if (t !== 'select') this.deselect();
    this.tools.tool = t;
    this.saveTools();
    this.root.querySelector('.tool-options').hidden = true;
    this.updateUi();
  }

  toggleOptions() {
    const o = this.root.querySelector('.tool-options');
    const t = this.tools.tool;
    if (!['pen', 'hl', 'eraser', 'text'].includes(t)) return;
    o.hidden = !o.hidden;
    this.buildOptions();
  }

  buildOptions() {
    const o = this.root.querySelector('.tool-options');
    const t = this.tools.tool;
    const PEN_COLORS = ['#1a1a1a', '#1f5fd6', '#d63a2f', '#1f9d55', '#8e44ad', '#e67e22'];
    const HL_COLORS = ['#ffe14d', '#7ee08a', '#ff8fc8', '#7cc8ff', '#ffb35c'];
    let html = '';
    if (t === 'pen' || t === 'hl' || t === 'text') {
      const opt = t === 'hl' ? this.tools.hl : this.tools.pen;
      const colors = t === 'hl' ? HL_COLORS : PEN_COLORS;
      html += '<div class="opt-row">' + colors.map(c => `<button class="swatch${opt.color === c ? ' on' : ''}" data-color="${c}" style="--c:${c}"></button>`).join('') +
        `<label class="swatch custom" style="--c:${opt.color}"><input type="color" value="${opt.color}"></label></div>`;
    }
    if (t === 'pen' || t === 'hl') {
      const opt = t === 'hl' ? this.tools.hl : this.tools.pen;
      const widths = t === 'hl' ? [8, 14, 22] : [1, 2, 3.5, 6];
      html += '<div class="opt-row">' + widths.map(w => `<button class="width${opt.width === w ? ' on' : ''}" data-width="${w}"><i style="--w:${Math.min(w * (t === 'hl' ? 1 : 2), 22)}px"></i></button>`).join('') + '</div>';
    }
    if (t === 'pen' || t === 'hl') {
      const opt = t === 'hl' ? this.tools.hl : this.tools.pen;
      const isFav = this.tools.favs.some(f => f.t === t && f.c === opt.color && f.w === opt.width);
      const on = t === 'hl' ? this.tools.hlStraight : this.tools.shapeSnap;
      html += `<div class="opt-row opt-text">
        <button class="seg${on ? ' on' : ''}" data-snap>${t === 'hl' ? '직선 보정' : '도형 보정'} ${on ? '켜짐' : '꺼짐'}</button>
        <button class="seg" data-addfav ${isFav || this.tools.favs.length >= 4 ? 'disabled' : ''}>★ 즐겨찾기에 추가</button></div>`;
      html += t === 'hl'
        ? '<p class="opt-hint">긋고 끝에서 펜을 잠깐 멈추면 반듯한 직선이 됩니다. 거의 가로면 수평으로 맞춰요</p>'
        : '<p class="opt-hint">선을 긋고 펜을 잠깐 멈추면 직선·원·사각형으로 바뀝니다</p>';
    }
    if (this.tools.favs.length && (t === 'pen' || t === 'hl')) {
      html += '<div class="opt-row fav-edit">' + this.tools.favs.map((f, i) =>
        `<span class="fav-chip"><i style="--c:${f.c};--w:${Math.min(f.w * (f.t === 'hl' ? 1 : 2), 18)}px" class="${f.t}"></i><button data-delfav="${i}" aria-label="즐겨찾기 삭제">✕</button></span>`).join('') + '</div>';
    }
    if (t === 'text') {
      html += '<div class="opt-row">' + [12, 18, 24, 32].map(s => `<button class="size${this.tools.text.size === s ? ' on' : ''}" data-size="${s}">${s}</button>`).join('') + '</div>';
    }
    if (t === 'eraser') {
      const er = this.tools.eraser;
      html += `<div class="opt-row"><button class="seg${er.mode === 'partial' ? ' on' : ''}" data-mode="partial">부분 지우기</button><button class="seg${er.mode === 'stroke' ? ' on' : ''}" data-mode="stroke">획 전체</button></div>`;
      html += '<div class="opt-row">' + [5, 10, 20, 35].map(s => `<button class="width${er.size === s ? ' on' : ''}" data-esize="${s}"><i style="--w:${Math.min(s, 26)}px;border-radius:50%"></i></button>`).join('') + '</div>';
    }
    o.innerHTML = html;
    const opt = t === 'hl' ? this.tools.hl : this.tools.pen;
    o.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { opt.color = b.dataset.color; this.afterOpt(); });
    const ci = o.querySelector('input[type=color]');
    if (ci) ci.oninput = () => { opt.color = ci.value; this.saveTools(); this.updateUi(); };
    if (ci) ci.onchange = () => this.afterOpt();
    o.querySelectorAll('[data-width]').forEach(b => b.onclick = () => { opt.width = Number(b.dataset.width); this.afterOpt(); });
    o.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { this.tools.text.size = Number(b.dataset.size); this.afterOpt(); });
    o.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { this.tools.eraser.mode = b.dataset.mode; this.afterOpt(); });
    o.querySelectorAll('[data-esize]').forEach(b => b.onclick = () => { this.tools.eraser.size = Number(b.dataset.esize); this.afterOpt(); });
    const snap = o.querySelector('[data-snap]');
    if (snap) snap.onclick = () => {
      if (t === 'hl') this.tools.hlStraight = !this.tools.hlStraight;
      else this.tools.shapeSnap = !this.tools.shapeSnap;
      this.afterOpt();
    };
    const add = o.querySelector('[data-addfav]');
    if (add) add.onclick = () => {
      this.tools.favs.push({ t, c: opt.color, w: opt.width });
      this.afterOpt();
      this.toast('도구 막대에 즐겨찾는 펜을 추가했습니다');
    };
    o.querySelectorAll('[data-delfav]').forEach(b => b.onclick = () => { this.tools.favs.splice(Number(b.dataset.delfav), 1); this.afterOpt(); });
  }

  // 알약 툴바의 빠른 색 3개 (펜·형광펜·텍스트)
  renderQuickColors() {
    const box = this.root.querySelector('.quick-colors');
    const t = this.tools.tool;
    const sets = { pen: ['#1a1a1a', '#1f5fd6', '#d63a2f'], text: ['#1a1a1a', '#1f5fd6', '#d63a2f'], hl: ['#ffe14d', '#7ee08a', '#ff8fc8'] };
    const colors = sets[t];
    if (!colors) { box.innerHTML = ''; return; }
    const opt = t === 'hl' ? this.tools.hl : this.tools.pen;
    box.innerHTML = colors.map(c => `<button class="qc${opt.color === c ? ' on' : ''}" data-qc="${c}" style="--c:${c}" aria-label="색 ${c}"></button>`).join('');
    box.querySelectorAll('[data-qc]').forEach(b => b.onclick = () => { opt.color = b.dataset.qc; this.afterOpt(); });
  }

  // 알약 툴바 손잡이: 끌어서 위/아래로, 그냥 누르면 위↔아래 전환
  bindPillGrip() {
    const pill = this.root.querySelector('.tool-pill');
    const grip = pill.querySelector('.pill-grip');
    let drag = null;
    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch {}
      const r = pill.getBoundingClientRect();
      drag = { y0: e.clientY, top0: r.top - this.root.getBoundingClientRect().top, moved: false };
    });
    grip.addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      if (Math.abs(dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      pill.classList.add('dragging');
      pill.style.top = drag.top0 + dy + 'px';
      pill.style.bottom = 'auto';
    });
    const end = e => {
      if (!drag) return;
      const rr = this.root.getBoundingClientRect();
      const top = drag.moved ? e.clientY - rr.top < rr.height / 2 : this.tools.pillPos !== 'top';
      drag = null;
      pill.classList.remove('dragging');
      pill.style.top = '';
      pill.style.bottom = '';
      this.tools.pillPos = top ? 'top' : 'bottom';
      this.saveTools();
      this.updateUi();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // 도구 막대의 즐겨찾는 펜 버튼
  renderFavs() {
    const box = this.root.querySelector('.favs');
    const t = this.tools.tool;
    box.innerHTML = this.tools.favs.map((f, i) => {
      const opt = f.t === 'hl' ? this.tools.hl : this.tools.pen;
      const on = t === f.t && opt.color === f.c && opt.width === f.w;
      return `<button class="fav${on ? ' on' : ''}" data-fav="${i}" title="${f.t === 'hl' ? '형광펜' : '펜'}"><i class="${f.t}" style="--c:${f.c};--w:${Math.min(f.w * (f.t === 'hl' ? 1 : 2), 16)}px"></i></button>`;
    }).join('');
    box.hidden = !this.tools.favs.length;
    box.querySelectorAll('[data-fav]').forEach(b => b.onclick = () => {
      const f = this.tools.favs[Number(b.dataset.fav)];
      const opt = f.t === 'hl' ? this.tools.hl : this.tools.pen;
      opt.color = f.c;
      opt.width = f.w;
      this.setTool(f.t);
    });
  }

  afterOpt() {
    this.saveTools();
    this.buildOptions();
    this.updateUi();
  }

  updateUi() {
    const R = this.root;
    const t = this.tools.tool;
    R.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    R.querySelector('[data-tool="pen"]').style.setProperty('--c', this.tools.pen.color);
    R.querySelector('[data-tool="hl"]').style.setProperty('--c', this.tools.hl.color);
    R.querySelector('[data-act="pen-only"]').classList.toggle('on', this.tools.penOnly);
    R.dataset.tool = t;
    R.dataset.penOnly = this.tools.penOnly ? '1' : '0';
    R.dataset.pill = this.tools.pillPos === 'top' ? 'top' : 'bottom';
    this.renderQuickColors();
    this.renderFavs();
    this.updatePastePill();
    this.updateUndoUi();
    this.updatePageLabel();
  }

  setUiHidden(hidden) {
    this.root.dataset.ui = hidden ? 'hidden' : '';
    this.root.querySelector('.float-bar').hidden = !hidden;
    this.root.querySelector('.tool-options').hidden = true;
    this.root.querySelector('.more-menu').hidden = true;
    this.updateUndoUi();
  }

  updateUndoUi() {
    this.root.querySelector('[data-act="undo-float"]').disabled = !this.undoStack.length;
    this.root.querySelector('[data-act="undo"]').disabled = !this.undoStack.length;
    this.root.querySelector('[data-act="redo"]').disabled = !this.redoStack.length;
  }

  currentIndex() {
    if (!this.note) return 0;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 3;
    let idx = 0;
    this.note.pages.forEach((pg, i) => {
      const el = this.pageEls.get(pg.id);
      if (el && el.offsetTop <= mid) idx = i;
    });
    return idx;
  }

  currentPageId() { return this.note.pages[this.currentIndex()].id; }

  updatePageLabel() {
    if (!this.note) return;
    this.root.querySelector('.page-label').textContent = `${this.currentIndex() + 1} / ${this.note.pages.length}`;
  }

  // ---------- 페이지 추가 / 삭제 / 이름 ----------
  addPage() { this.addPageAfter(this.currentIndex()); }

  addPageAfter(i) {
    this.root.querySelector('.more-menu').hidden = true;
    const cur = this.note.pages[i];
    const bgSel = this.root.querySelector('.more-menu select');
    const pg = { id: uid(), w: cur.w, h: cur.h, pdf: null, bg: bgSel ? bgSel.value : 'plain' };
    this.note.pages.splice(i + 1, 0, pg);
    this.afterPagesChanged();
    this.goToPage(i + 1);
    this.toast(`${i + 2}쪽에 빈 페이지를 추가했습니다`);
  }

  deletePage() { this.deletePageAt(this.currentIndex()); }

  deletePageAt(i) {
    this.root.querySelector('.more-menu').hidden = true;
    if (this.note.pages.length <= 1) return this.toast('마지막 페이지는 지울 수 없습니다');
    if (!confirm(`${i + 1}쪽을 삭제할까요? (필기 포함, 되돌릴 수 없음)`)) return;
    const [pg] = this.note.pages.splice(i, 1);
    delete this.ink[pg.id];
    this.undoStack = this.undoStack.filter(a => a.pid !== pg.id);
    this.redoStack = this.redoStack.filter(a => a.pid !== pg.id);
    const top = this.scroller.scrollTop;
    this.afterPagesChanged();
    this.scroller.scrollTop = top;
  }

  movePage(i, dir) {
    const j = i + dir;
    const pages = this.note.pages;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    this.afterPagesChanged();
    this.goToPage(j);
  }

  duplicatePage(i) {
    const src = this.note.pages[i];
    const pg = Object.assign({}, src, { id: uid() });
    this.note.pages.splice(i + 1, 0, pg);
    const ink = this.ink[src.id];
    if (ink) {
      const copy = JSON.parse(JSON.stringify(ink));
      for (const k of ['strokes', 'texts', 'images']) copy[k].forEach(o => { o.id = uid(); });
      this.ink[pg.id] = copy;
    }
    this.afterPagesChanged();
    this.goToPage(i + 1);
    this.toast(`${i + 1}쪽을 복제했습니다`);
  }

  afterPagesChanged() {
    this.buildPages();
    this.scheduleSave();
    this.updateUi();
    if (this.panel) this.panel.rebuild();
  }

  goToPage(i) {
    const pg = this.note.pages[i];
    const el = pg && this.pageEls.get(pg.id);
    if (el) this.scroller.scrollTop = el.offsetTop - PAGE_GAP;
    this.updatePageLabel();
  }

  rename() {
    this.root.querySelector('.more-menu').hidden = true;
    const name = prompt('노트 이름', this.note.name);
    if (!name || !name.trim()) return;
    this.note.name = name.trim();
    this.root.querySelector('.title').textContent = this.note.name;
    this.scheduleSave();
  }

  // ---------- 썸네일 ----------
  async makeThumb() {
    const pg = this.note.pages[0];
    const W = 360;
    const k = W / pg.w;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = Math.round(pg.h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (pg.pdf != null && this.pdf) {
      const page = await this.pdf.getPage(pg.pdf + 1);
      const vp = page.getViewport({ scale: W / page.getViewport({ scale: 1 }).width });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } else {
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawPaper(ctx, pg.w, pg.h, pg.bg);
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawPageInk(ctx, this.ink[pg.id]);
    const pi = this.ink[pg.id];
    if (pi) drawTexts(ctx, pi.texts);
    return c.toDataURL('image/jpeg', 0.7);
  }
}
