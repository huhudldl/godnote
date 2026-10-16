// 페이지 목록 패널: 썸네일로 이동 · 순서 바꾸기 · 복제 · 삭제 · 빈 페이지 추가
import { drawPageInk, drawPaper, drawTexts } from './editor.js';

const THUMB_W = 150;

export class PagePanel {
  constructor(editor) {
    this.ed = editor;
    this.root = editor.root.querySelector('.page-panel');
    this.list = this.root.querySelector('.pp-list');
    this.open = false;
    this.dirty = new Set();
    this.observer = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) this.renderThumb(e.target);
    }, { root: this.list, rootMargin: '300px 0px' });
    this.root.querySelector('[data-act="pp-close"]').onclick = () => this.toggle(false);
    this.root.querySelector('[data-act="pp-add"]').onclick = () => { this.ed.addPage(); };
    editor.root.querySelector('[data-act="pages"]').onclick = () => this.toggle(!this.open);
    document.addEventListener('pointerdown', e => {
      if (!e.target.closest('.pp-menu') && !e.target.closest('.pp-more')) this.closeMenu();
    });
  }

  toggle(open) {
    this.open = open;
    this.root.hidden = !open;
    this.ed.root.querySelector('[data-act="pages"]').classList.toggle('on', open);
    if (open) this.rebuild();
    else { this.observer.disconnect(); this.list.innerHTML = ''; this.closeMenu(); }
  }

  rebuild() {
    if (!this.open || !this.ed.note) return;
    this.observer.disconnect();
    this.closeMenu();
    const cur = this.ed.currentIndex();
    this.list.innerHTML = '';
    this.ed.note.pages.forEach((pg, i) => {
      const item = document.createElement('div');
      item.className = 'pp-item' + (i === cur ? ' on' : '');
      item.dataset.pid = pg.id;
      item.innerHTML = `<div class="pp-thumb" style="aspect-ratio:${pg.w}/${pg.h}"><canvas></canvas></div>
        <div class="pp-foot"><span>${i + 1}</span><button class="pp-more" aria-label="페이지 메뉴">⋯</button></div>`;
      item.querySelector('.pp-thumb').onclick = () => {
        this.ed.goToPage(i);
        this.highlight(i);
        if (matchMedia('(max-width: 900px)').matches) this.toggle(false);
      };
      item.querySelector('.pp-more').onclick = e => { e.stopPropagation(); this.menu(i, e.currentTarget); };
      this.list.appendChild(item);
      this.observer.observe(item);
    });
    const on = this.list.querySelector('.pp-item.on');
    if (on) on.scrollIntoView({ block: 'center' });
  }

  highlight(i) {
    if (!this.open) return;
    this.list.querySelectorAll('.pp-item').forEach((el, j) => el.classList.toggle('on', j === i));
  }

  // 필기가 바뀐 페이지의 썸네일만 다시 그림
  markDirty(pid) {
    if (!this.open) return;
    this.dirty.add(pid);
    clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => {
      for (const id of this.dirty) {
        const el = this.list.querySelector(`.pp-item[data-pid="${id}"]`);
        if (el) { el._done = false; this.renderThumb(el); }
      }
      this.dirty.clear();
    }, 800);
  }

  async renderThumb(item) {
    if (item._done) return;
    item._done = true;
    const ed = this.ed;
    const pg = ed.pageOf(item.dataset.pid);
    if (!pg) return;
    const dpr = window.devicePixelRatio || 1;
    const k = (THUMB_W * dpr) / pg.w;
    const c = document.createElement('canvas');
    c.width = Math.round(pg.w * k);
    c.height = Math.round(pg.h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    try {
      if (pg.pdf != null && ed.pdf) {
        const page = await ed.pdf.getPage(pg.pdf + 1);
        const vp = page.getViewport({ scale: c.width / page.getViewport({ scale: 1 }).width });
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      } else {
        ctx.setTransform(k, 0, 0, k, 0, 0);
        drawPaper(ctx, pg.w, pg.h, pg.bg);
      }
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const pi = ed.ink[pg.id];
      if (pi) { drawPageInk(ctx, pi); drawTexts(ctx, pi.texts); }
    } catch (e) { console.warn(e); }
    const target = item.querySelector('canvas');
    target.width = c.width;
    target.height = c.height;
    target.getContext('2d').drawImage(c, 0, 0);
    c.width = 0; c.height = 0;
  }

  closeMenu() {
    const m = this.ed.root.querySelector('.pp-menu');
    if (m) m.remove();
  }

  menu(i, anchor) {
    this.closeMenu();
    const n = this.ed.note.pages.length;
    const m = document.createElement('div');
    m.className = 'pp-menu popup';
    m.innerHTML = `
      <button data-a="up" ${i === 0 ? 'disabled' : ''}>앞으로 이동</button>
      <button data-a="down" ${i === n - 1 ? 'disabled' : ''}>뒤로 이동</button>
      <button data-a="dup">페이지 복제</button>
      <button data-a="blank">뒤에 빈 페이지 추가</button>
      <button data-a="del" class="danger" ${n <= 1 ? 'disabled' : ''}>페이지 삭제</button>`;
    this.ed.root.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const rr = this.ed.root.getBoundingClientRect();
    m.style.left = Math.min(r.left - rr.left, rr.width - 200) + 'px';
    m.style.top = Math.min(r.bottom - rr.top + 4, rr.height - m.offsetHeight - 10) + 'px';
    m.onclick = e => {
      const a = e.target.dataset.a;
      if (!a || e.target.disabled) return;
      this.closeMenu();
      if (a === 'up') this.ed.movePage(i, -1);
      else if (a === 'down') this.ed.movePage(i, 1);
      else if (a === 'dup') this.ed.duplicatePage(i);
      else if (a === 'blank') this.ed.addPageAfter(i);
      else if (a === 'del') this.ed.deletePageAt(i);
    };
  }
}
