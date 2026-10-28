/**
 * Takes the README and Store screenshots of the real interface, without the
 * desktop shell: it fakes the Tauri bridge in the page and draws sample
 * documents itself, so no private file ever appears in a picture.
 *
 *   cd frontend && npx vite --port 5199 &
 *   node scripts/screenshots/capture.cjs [out-dir]        (from the repository root)
 *
 * Needs Playwright with Chromium. Output: docs/assets/screenshot-N.png (1440x900),
 * or, with SHOTS_SET=store and SHOTS_LANG=en|id, the numbered Store set (see below).
 */
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.SHOTS_URL || 'http://localhost:5199';
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'docs', 'assets'));
const SAMPLE = 'C:\\Users\\Dhoni\\Documents\\Quarterly report.pdf';

/** Runs in the page before the app starts: the fake bridge. */
function installBridge(samplePath) {
  const PAGES = 5;
  const callbacks = new Map();
  const listeners = [];
  let nextId = 1;

  function drawPage(n, w, h) {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    const s = w / 595;
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1f4e8c'; g.fillRect(0, 0, w, 74 * s);
    g.fillStyle = '#fff'; g.font = `700 ${22 * s}px sans-serif`;
    g.fillText('Quarterly report', 40 * s, 46 * s);
    g.font = `${11 * s}px sans-serif`; g.fillText(`Q3 2026 \u00b7 page ${n}`, 440 * s, 44 * s);
    g.fillStyle = '#1b2a3a'; g.font = `700 ${15 * s}px sans-serif`;
    g.fillText(['Summary', 'Revenue', 'Costs', 'Regions', 'Outlook'][(n - 1) % 5], 40 * s, 120 * s);
    g.fillStyle = '#c9d2dc';
    const widths = [1, 0.96, 1, 0.9, 0.98, 0.7, 1, 0.94, 0.99, 0.6];
    for (let i = 0; i < 10; i += 1) {
      g.fillRect(40 * s, (140 + i * 16) * s, 515 * s * widths[(i + n) % 10], 6 * s);
    }
    // chart
    const bars = [0.5, 0.7, 0.55, 0.85, 0.65, 0.95];
    const baseY = 560 * s;
    g.strokeStyle = '#9fb0c3'; g.lineWidth = s;
    g.beginPath(); g.moveTo(60 * s, 330 * s); g.lineTo(60 * s, baseY); g.lineTo(555 * s, baseY); g.stroke();
    bars.forEach((v, i) => {
      const bh = v * (200 + (n % 3) * 10) * s;
      g.fillStyle = i % 2 ? '#3aa6a0' : '#1f4e8c';
      g.fillRect((80 + i * 78) * s, baseY - bh, 48 * s, bh);
    });
    g.fillStyle = '#c9d2dc';
    for (let i = 0; i < 9; i += 1) g.fillRect(40 * s, (590 + i * 16) * s, 515 * s * widths[(i + 2 * n) % 10], 6 * s);
    return c.convertToBlob({ type: 'image/png' });
  }

  const u32 = (view, offset, value) => view.setUint32(offset, value, true);
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0; parts.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  };

  async function renderMessage(page, dpi) {
    const w = Math.round(595 * dpi / 72); const h = Math.round(842 * dpi / 72);
    const png = new Uint8Array(await (await drawPage(page, w, h)).arrayBuffer());
    const head = new Uint8Array(12); const v = new DataView(head.buffer);
    u32(v, 0, w); u32(v, 4, h); u32(v, 8, dpi);
    return concat([head, png]).buffer;
  }

  async function thumbnails(start, count, width) {
    const total = PAGES; const parts = [];
    const head = new Uint8Array(12); const hv = new DataView(head.buffer);
    const n = Math.max(0, Math.min(count, total - start + 1)); // `start` is a 1-based page
    u32(hv, 0, start); u32(hv, 4, total); u32(hv, 8, n); parts.push(head);
    for (let i = 0; i < n; i += 1) {
      const h = Math.round(width * 842 / 595);
      const png = new Uint8Array(await (await drawPage(start + i, width, h)).arrayBuffer());
      const ph = new Uint8Array(16); const pv = new DataView(ph.buffer);
      u32(pv, 0, start + i); u32(pv, 4, width); u32(pv, 8, h); u32(pv, 12, png.length);
      parts.push(ph, png);
    }
    return concat(parts).buffer;
  }

  const handlers = {
    core_health: () => ({ appVersion: '2.0.0', coreVersion: '0.1.0' }),
    core_info: () => ({ version: '0.1.0', cpuThreads: 8, totalMemoryBytes: 16e9, availableMemoryBytes: 8e9 }),
    core_pdf_info: () => ({ sizeBytes: 1843200, pages: PAGES, encrypted: false, metadata: { format: 'PDF 1.7', title: 'Quarterly report', author: '', subject: '', keywords: '', creator: '', producer: '', creationDate: '', modDate: '' } }),
    core_pdf_probe: () => ({ sizeBytes: 8_400_000, pages: PAGES, encrypted: false }),
    core_pdf_render_page: (a) => renderMessage(a.page, a.dpi).then((b) => b.slice(12)),
    core_file_sizes: () => [],
    core_organize_open: () => ({ documentId: 'doc1', name: 'Quarterly report.pdf', kind: 'pdf', pageCount: PAGES }),
    core_organize_thumbnails: (a) => thumbnails(a.start, a.count, a.width),
    core_organize_release: () => true,
    core_canvas_pages_meta: (a) => ({ total: PAGES, pages: Array.from({ length: PAGES }, (_, index) => ({ index, widthPt: 595, heightPt: 842, width: Math.round(595 * a.dpi / 72), height: Math.round(842 * a.dpi / 72), dpi: a.dpi })) }),
    core_canvas_render_page: (a) => renderMessage(a.page, a.dpi),
    core_font_list: () => [],
    core_pdf_describe: () => ({ pages: PAGES, sizeBytes: 1843200, encrypted: false }),
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback(cb) { const id = nextId++; callbacks.set(id, cb); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      if (cmd === 'plugin:event|listen') { listeners.push({ event: args.event, handler: args.handler }); return nextId++; }
      if (cmd === 'plugin:event|unlisten') return null;
      const handler = handlers[cmd];
      if (!handler) { console.warn('[shots] unhandled command', cmd); throw { code: 'internal', message: `no mock for ${cmd}` }; }
      return handler(args || {});
    },
  };
  window.__shotsEmit = (event, payload) => {
    listeners.filter((l) => l.event === event).forEach((l) => callbacks.get(l.handler)?.({ event, id: 0, payload }));
  };
  window.__shotsDrop = (paths) => window.__shotsEmit('tauri://drag-drop', { paths, position: { x: 10, y: 10 } });
  window.__shotsSample = samplePath;
}

async function shot(browser, { file, route, lang = 'en', theme = 'light', drop, after, size = { width: 1440, height: 900 } }) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addInitScript(installBridge, SAMPLE);
  await page.addInitScript(([l, t]) => {
    localStorage.setItem('app_language', l);
    localStorage.setItem('app_theme', t);
    sessionStorage.setItem('app_skip_splash_once', '1');
  }, [lang, theme]);
  page.on('console', (m) => { if (m.text().includes('[shots]')) console.log(m.text()); });
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (drop) {
    await page.evaluate((p) => window.__shotsDrop([p]), SAMPLE);
    await page.waitForTimeout(4500);
  }
  if (after) await after(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, file) });
  console.log('wrote', file);
  await context.close();
}

// Store sets: the same eight pages in English and Indonesian, named in upload order.
//   SHOTS_SET=store SHOTS_LANG=en node scripts/screenshots/capture.cjs docs/brand/store/screenshots/en
const STORE = process.env.SHOTS_SET === 'store';
const LANG = process.env.SHOTS_LANG || 'en';
const FIT = LANG === 'id' ? 'Sesuaikan ke Halaman (Ctrl+0)' : 'Fit to Page (Ctrl+0)';

async function fitCanvas(page) {
  await page.locator(`[title="${FIT}"]`).first().click().catch(() => {});
  await page.waitForTimeout(2000);
}

async function settingsShot(page) {
  await page.locator('#settings-licenses').scrollIntoViewIfNeeded();
}

(async () => {
  const browser = await chromium.launch();
  if (STORE) {
    const lang = LANG;
    await shot(browser, { file: '01-home.png', route: '/', lang });
    await shot(browser, { file: '02-edit-content.png', route: '/edit-content', lang });
    await shot(browser, { file: '03-canvas-pdf.png', route: '/edit-canvas', drop: true, lang, after: fitCanvas });
    await shot(browser, { file: '04-pdf-and-image.png', route: '/converter', drop: true, lang });
    await shot(browser, { file: '05-organize.png', route: '/organize', drop: true, lang });
    await shot(browser, { file: '06-compress.png', route: '/compress', drop: true, lang });
    await shot(browser, { file: '07-dark-theme.png', route: '/', theme: 'dark', lang });
    await shot(browser, { file: '08-settings.png', route: '/settings', lang, after: settingsShot });
    await browser.close();
    return;
  }
  await shot(browser, { file: 'screenshot-1.png', route: '/' });
  await shot(browser, { file: 'screenshot-2.png', route: '/organize', drop: true });
  await shot(browser, { file: 'screenshot-3.png', route: '/converter', drop: true });
  await shot(browser, { file: 'screenshot-4.png', route: '/edit-canvas', drop: true, after: fitCanvas });
  await shot(browser, { file: 'screenshot-5.png', route: '/compress', drop: true });
  await shot(browser, { file: 'screenshot-6.png', route: '/', lang: 'id' });
  await shot(browser, { file: 'screenshot-7.png', route: '/', theme: 'dark' });
  await shot(browser, { file: 'screenshot-8.png', route: '/edit-content' });
  await shot(browser, { file: 'screenshot-9.png', route: '/settings', after: settingsShot });
  await browser.close();
})();
