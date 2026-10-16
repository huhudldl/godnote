// 필기 포함 PDF 내보내기
// 원본 PDF 페이지는 벡터 그대로 복사하고, 필기·텍스트·이미지는 투명 이미지로 위에 얹는다.
import { drawPageInk, drawPaper, drawTexts } from './editor.js';

const EXPORT_SCALE = 2;              // 144dpi
const MAX_PIXELS = 12_000_000;

function loadScript(src) {
  if (window.PDFLib) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('PDF 도구를 불러오지 못했습니다'));
    document.head.appendChild(s);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
}

function canvasFor(pg) {
  let k = EXPORT_SCALE;
  if (pg.w * pg.h * k * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (pg.w * pg.h));
  const c = document.createElement('canvas');
  c.width = Math.round(pg.w * k);
  c.height = Math.round(pg.h * k);
  return { c, k };
}

function hasContent(pi) {
  return pi && (pi.strokes.length || pi.texts.length || pi.images.length);
}

// 이미지 → 필기(형광펜 → 펜) → 텍스트 순서로 그림
async function drawAnnotations(ctx, pi) {
  if (!pi) return;
  for (const im of pi.images) {
    try { ctx.drawImage(await loadImage(im.src), im.x, im.y, im.w, im.h); } catch {}
  }
  drawPageInk(ctx, pi);
  drawTexts(ctx, pi.texts);
}

function toBytes(canvas, type, q) {
  return new Promise(res => canvas.toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), type, q));
}

export async function exportNotePdf(note, ink, pdfBlob, onProgress = () => {}) {
  await loadScript('vendor/pdf-lib.min.js');
  const { PDFDocument } = window.PDFLib;
  const out = await PDFDocument.create();
  out.setTitle(note.name);
  out.setCreator('갓 노트');

  let src = null, srcJs = null;
  if (note.hasPdf && pdfBlob) {
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
    src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    srcJs = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  }

  for (let i = 0; i < note.pages.length; i++) {
    onProgress(i + 1, note.pages.length);
    const pg = note.pages[i];
    const pi = ink[pg.id];
    const usePdf = pg.pdf != null && src && pg.pdf < src.getPageCount();

    // 회전 없는 원본 페이지: 벡터 그대로 복사 + 필기 덧씌우기
    if (usePdf && src.getPage(pg.pdf).getRotation().angle % 360 === 0) {
      const [copied] = await out.copyPages(src, [pg.pdf]);
      const page = out.addPage(copied);
      if (hasContent(pi)) {
        const { c, k } = canvasFor(pg);
        const ctx = c.getContext('2d');
        ctx.setTransform(k, 0, 0, k, 0, 0);
        await drawAnnotations(ctx, pi);
        const png = await out.embedPng(await toBytes(c, 'image/png'));
        const crop = page.getCropBox();
        page.drawImage(png, { x: crop.x, y: crop.y, width: crop.width, height: crop.height });
      }
      continue;
    }

    // 빈 페이지 또는 회전된 페이지: 한 장의 그림으로 만듦
    const { c, k } = canvasFor(pg);
    const ctx = c.getContext('2d');
    if (usePdf) {
      const p = await srcJs.getPage(pg.pdf + 1);
      const vp = p.getViewport({ scale: c.width / p.getViewport({ scale: 1 }).width });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
    } else {
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawPaper(ctx, pg.w, pg.h, pg.bg);
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);
    await drawAnnotations(ctx, pi);
    const jpg = await out.embedJpg(await toBytes(c, 'image/jpeg', 0.92));
    const page = out.addPage([pg.w, pg.h]);
    page.drawImage(jpg, { x: 0, y: 0, width: pg.w, height: pg.h });
  }
  if (srcJs) srcJs.destroy();
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

// 아이패드: 공유 시트(파일에 저장·AirDrop 등), 맥: 다운로드 폴더로 저장
// 버튼을 누른 직후에 호출 (아이패드 공유 시트용)
export async function shareNow(blob, filename) {
  const file = new File([blob], filename, { type: 'application/pdf' });
  try {
    await navigator.share({ files: [file], title: filename });
    return 'shared';
  } catch (e) {
    return e.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

export async function saveOrShare(blob, filename) {
  const file = new File([blob], filename, { type: 'application/pdf' });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      if (e.name === 'NotAllowedError') return 'needTap';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}
