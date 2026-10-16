// 노트 안 글자 검색: PDF 본문 + 직접 쓴 텍스트 상자
// 띄어쓰기는 무시하고 찾음 (PDF 는 글자 사이가 따로 떨어져 있는 경우가 많음)

const norm = s => s.replace(/\s+/g, '').toLowerCase();

export class SearchBar {
  constructor(editor) {
    this.ed = editor;
    this.bar = editor.root.querySelector('.search-bar');
    this.input = this.bar.querySelector('input');
    this.countEl = this.bar.querySelector('.sr-count');
    this.cache = new Map();   // pdf 페이지 번호 → { chars, map }
    this.results = [];
    this.cur = -1;
    editor.root.querySelector('[data-act="search"]').onclick = () => this.toggle(this.bar.hidden);
    this.bar.querySelector('[data-act="sr-close"]').onclick = () => this.toggle(false);
    this.bar.querySelector('[data-act="sr-prev"]').onclick = () => this.step(-1);
    this.bar.querySelector('[data-act="sr-next"]').onclick = () => this.step(1);
    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), 250);
    });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') this.toggle(false);
    });
  }

  reset() {
    this.cache.clear();
    this.toggle(false);
  }

  toggle(open) {
    this.bar.hidden = !open;
    this.ed.root.querySelector('[data-act="search"]').classList.toggle('on', open);
    if (open) { this.input.focus(); this.input.select(); if (this.input.value) this.run(); }
    else { this.clearHits(); this.results = []; this.cur = -1; this.countEl.textContent = ''; }
  }

  async pageText(pg) {
    if (this.cache.has(pg.pdf)) return this.cache.get(pg.pdf);
    const page = await this.ed.pdf.getPage(pg.pdf + 1);
    const vp = page.getViewport({ scale: pg.w / page.getViewport({ scale: 1 }).width });
    const tc = await page.getTextContent();
    let chars = '';
    const map = [];   // 글자 위치 → [항목 번호, 항목 안 글자 위치]
    const items = [];
    tc.items.forEach(it => {
      if (!it.str) return;
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      const fontH = Math.hypot(tx[2], tx[3]) || 10;
      const idx = items.push({ x: tx[4], y: tx[5] - fontH, w: it.width * vp.scale, h: fontH * 1.2, len: it.str.length }) - 1;
      [...it.str].forEach((ch, ci) => {
        if (/\s/.test(ch)) return;
        chars += ch.toLowerCase();
        map.push([idx, ci]);
      });
    });
    const data = { chars, map, items };
    this.cache.set(pg.pdf, data);
    return data;
  }

  async run() {
    const q = norm(this.input.value);
    this.clearHits();
    this.results = [];
    this.cur = -1;
    if (!q) { this.countEl.textContent = ''; return; }
    this.countEl.textContent = '찾는 중…';
    const token = (this.token = {});
    const ed = this.ed;
    for (let i = 0; i < ed.note.pages.length; i++) {
      const pg = ed.note.pages[i];
      const rects = [];
      if (pg.pdf != null && ed.pdf) {
        try {
          const { chars, map, items } = await this.pageText(pg);
          if (token !== this.token) return;
          let from = 0, at;
          while ((at = chars.indexOf(q, from)) !== -1) {
            // 찾은 글자들이 걸친 항목마다 사각형 하나
            const spans = new Map();
            for (let k = at; k < at + q.length; k++) {
              const [ii, ci] = map[k];
              const s = spans.get(ii) || [ci, ci];
              s[0] = Math.min(s[0], ci); s[1] = Math.max(s[1], ci);
              spans.set(ii, s);
            }
            const group = [];
            for (const [ii, [a, b]] of spans) {
              const it = items[ii];
              const cw = it.w / Math.max(1, it.len);
              group.push({ x: it.x + cw * a, y: it.y, w: cw * (b - a + 1), h: it.h });
            }
            rects.push(group);
            from = at + q.length;
          }
        } catch (e) { console.warn(e); }
      }
      const pi = ed.ink[pg.id];
      if (pi) for (const t of pi.texts) {
        if (norm(t.text).includes(q)) {
          const lines = Math.max(1, t.text.split('\n').length);
          rects.push([{ x: t.x - 2, y: t.y - 2, w: t.w + 4, h: t.s * 1.3 * lines + 4 }]);
        }
      }
      for (const g of rects) this.results.push({ i, pid: pg.id, rects: g });
    }
    if (token !== this.token) return;
    this.countEl.textContent = this.results.length ? `0 / ${this.results.length}` : '결과 없음';
    this.drawHits();
    if (this.results.length) this.step(1);
  }

  clearHits() {
    this.ed.root.querySelectorAll('.search-hit').forEach(h => h.remove());
  }

  // 찾은 위치에 노란 표시 (확대·축소 때도 다시 그림)
  drawHits() {
    this.clearHits();
    if (this.bar.hidden) return;
    const s = this.ed.scale;
    this.results.forEach((r, n) => {
      const el = this.ed.pageEls.get(r.pid);
      if (!el) return;
      for (const b of r.rects) {
        const d = document.createElement('div');
        d.className = 'search-hit' + (n === this.cur ? ' cur' : '');
        Object.assign(d.style, { left: b.x * s + 'px', top: b.y * s + 'px', width: b.w * s + 'px', height: b.h * s + 'px' });
        el.appendChild(d);
      }
    });
  }

  step(dir) {
    if (!this.results.length) return;
    this.cur = (this.cur + dir + this.results.length) % this.results.length;
    const r = this.results[this.cur];
    this.countEl.textContent = `${this.cur + 1} / ${this.results.length}`;
    const el = this.ed.pageEls.get(r.pid);
    const s = this.ed.scale;
    const b = r.rects[0];
    const sc = this.ed.scroller;
    sc.scrollTop = el.offsetTop + b.y * s - sc.clientHeight / 3;
    const left = el.offsetLeft + b.x * s - sc.clientWidth / 2;
    if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft = left;
    this.drawHits();
  }
}
