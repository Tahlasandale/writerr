// Suite de tests headless pour Writer Deck (index.html).
//   npm test              démarre son propre serveur statique et lance un Chromium local
//   node writerr.test.js A5 C7   ne rejoue que les groupes dont le nom contient A5 ou C7
// Les artefacts d'export sont écrits dans tests/.tmp/.
const fsx = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { serve } = require('./serve');
const { executablePath } = require('./chrome');

const ART = path.join(__dirname, '.tmp');
fsx.mkdirSync(ART, { recursive: true });

async function putCaret(page, i, off) {
  await page.evaluate(({ i, off }) => {
    const l = document.querySelectorAll('#ed > *')[i];
    if (!l) throw new Error('no line #' + i);
    const total = l.textContent.length;
    const o = Math.max(0, Math.min(off, total));
    const r = document.createRange();
    if (o >= total) { r.selectNodeContents(l); r.collapse(false); }
    else {
      let rem = o, node = null;
      const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) { if (rem <= n.length) { node = n; break; } rem -= n.length; }
      r.setStart(node, rem);
      r.collapse(true);
    }
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    document.querySelector('#ed').focus();
  }, { i, off });
}
async function type(page, t) { await page.evaluate(x => document.execCommand('insertText', false, x), t); await new Promise(r => setTimeout(r, 40)); }
async function key(page, k, mods = {}) {
  return page.evaluate(({ k, mods }) => {
    const ev = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods));
    document.querySelector('#ed').dispatchEvent(ev);
    return ev.defaultPrevented;
  }, { k, mods });
}
// rebuild the document using the app's own typing path so markers get parsed
async function reset(page, ls) {
  // build through the app's own input path so markers get parsed, but disable auto-continuation
  await page.evaluate(list => {
    const ed = document.querySelector('#ed');
    ed.innerHTML = '';
    list.forEach(t => { const d = document.createElement('div'); d.className = 'l'; d.textContent = t; ed.appendChild(d); });
  }, ls);
  await new Promise(r => setTimeout(r, 40));
  // let the app's own input handler render each line (it only renders the caret's line per event)
  for (let i = 0; i < ls.length; i++) { await putCaret(page, i, 0); await page.evaluate(() => document.querySelector('#ed').dispatchEvent(new Event('input', { bubbles: true }))); }
  await putCaret(page, 0, 0);
}
const L = page => page.evaluate(() => [...document.querySelectorAll('#ed > *')].map(l => l.className + '|' + l.textContent));
const txt = page => page.evaluate(() => [...document.querySelectorAll('#ed > *')].map(l => l.textContent));
const join = L => L.join(' ⏎ ');
const sl = page => page.evaluate(() => ({ hidden: document.querySelector('#sl').hidden, items: [...document.querySelectorAll('#sl button')].map(b => b.textContent), sel: [...document.querySelectorAll('#sl button')].findIndex(b => b.getAttribute('aria-selected') === 'true') }));

const R = [];
function check(n, ok, info) { R.push({ n, ok }); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (ok ? '' : '\n         >> ' + JSON.stringify(info, null, 0))); }
const only = process.argv[2];
const want = n => !only || n.includes(only);

(async () => {
  const server = await serve(0);
  const BASE = server.url;
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errs.push(m.text()); });
  await page.goto(BASE + '/web/index.html', { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 400));

  /* ---------------- A. slash commands: whitespace handling ---------------- */
  if (want('A1')) { await reset(page, ['Bonjour']); await putCaret(page, 0, 7); await type(page, ' /h1'); await key(page, 'Enter'); check('A1 heading after text → "# Bonjour" (no trailing space)', (await txt(page))[0] === '# Bonjour', await txt(page)); }
  if (want('A2')) { await reset(page, ['Bonjour']); await putCaret(page, 0, 7); await type(page, ' /bul'); await key(page, 'Enter'); check('A2 bullet after text → "- Bonjour" (no double space)', (await txt(page))[0] === '- Bonjour', await txt(page)); }
  if (want('A3')) { await reset(page, ['- a']); await putCaret(page, 0, 3); await type(page, ' /h1'); await key(page, 'Enter'); check('A3 heading replaces existing list marker', (await txt(page))[0] === '# a', await txt(page)); }
  if (want('A4')) { await reset(page, ['- a']); await putCaret(page, 0, 3); await type(page, ' /quote'); await key(page, 'Enter'); check('A4 quote replaces list marker', (await txt(page))[0] === '> a', await txt(page)); }
  if (want('A5')) {
    await reset(page, ['- a']); await putCaret(page, 0, 3); await type(page, ' /bold'); await key(page, 'Enter');
    const c = await page.evaluate(() => ({ t: document.querySelector('#ed > *').textContent, off: getSelection().anchorOffset, before: getSelection().anchorNode.textContent.slice(0, getSelection().anchorOffset) }));
    check('A5 bold inline: separator space kept, caret between **', c.t === '- a ****' && c.before === 'a **' && c.off === 4, c);
  }
  if (want('A6')) { await reset(page, ['- a']); await putCaret(page, 0, 3); await type(page, ' /task'); await key(page, 'Enter'); check('A6 checkbox via /task replaces list marker', (await txt(page))[0] === '- [ ] a', await txt(page)); }
  if (want('A7')) { await reset(page, ['1. a']); await putCaret(page, 0, 4); await type(page, ' /h2'); await key(page, 'Enter'); check('A7 heading replaces numbered marker', (await txt(page))[0] === '## a', await txt(page)); }
  if (want('A8')) { // switch heading level on an existing heading
    await reset(page, ['# a']); await putCaret(page, 0, 3); await type(page, ' /h2'); await key(page, 'Enter');
    check('A8 h1→h2 rewrite (no doubled prefix)', (await txt(page))[0] === '## a', await txt(page)); }
  if (want('A9')) { await reset(page, ['## a']); await putCaret(page, 0, 4); await type(page, ' /text'); await key(page, 'Enter'); check('A9 /text strips heading prefix', (await txt(page))[0] === 'a', await txt(page)); }

  /* ---------------- B. caret placement ---------------- */
  if (want('B1')) { await reset(page, ['un deux']); await putCaret(page, 0, 7); await type(page, ' /h1'); await key(page, 'Enter');
    const c = await page.evaluate(() => ({ before: getSelection().anchorNode.textContent.slice(0, getSelection().anchorOffset), full: document.querySelector('#ed > *').textContent }));
    check('B1 caret after heading text', c.full === '# un deux' && c.before === 'un deux', c); }
  if (want('B1b')) { // command typed mid-word keeps the rest of the word, caret right before it
    await reset(page, ['un deux']); await putCaret(page, 0, 6); await type(page, ' /h1'); await key(page, 'Enter');
    const c = await page.evaluate(() => ({ before: getSelection().anchorNode.textContent.slice(0, getSelection().anchorOffset), full: document.querySelector('#ed > *').textContent }));
    check('B1b mid-word command keeps tail, caret before it', c.full === '# un deu x' && c.before === 'un deu ', c); }

  /* ---------------- C. Enter continuations ---------------- */
  if (want('C1')) { await reset(page, ['- un']); await putCaret(page, 0, 4); await key(page, 'Enter'); await type(page, 'deux'); await key(page, 'Enter'); await key(page, 'Enter');
    check('C1 bullet continues then exits', join(await txt(page)) === '- un ⏎ - deux ⏎ ', await txt(page)); }
  if (want('C2')) { await reset(page, ['1. un']); await putCaret(page, 0, 5); await key(page, 'Enter'); await type(page, 'deux'); await key(page, 'Enter'); await key(page, 'Enter');
    check('C2 numbered continues then exits', join(await txt(page)) === '1. un ⏎ 2. deux ⏎ ', await txt(page)); }
  if (want('C3')) { await reset(page, ['> a']); await putCaret(page, 0, 3); await key(page, 'Enter'); await type(page, 'b'); await key(page, 'Enter'); await key(page, 'Enter');
    check('C3 quote continues then EXITS on empty line', join(await txt(page)) === '> a ⏎ > b ⏎ ', await txt(page)); }
  if (want('C4')) { await reset(page, ['- [ ] a']); await putCaret(page, 0, 8); await key(page, 'Enter'); await type(page, 'b'); await key(page, 'Enter'); await key(page, 'Enter');
    check('C4 checkbox continues then exits', join(await txt(page)) === '- [ ] a ⏎ - [ ] b ⏎ ', await txt(page)); }
  if (want('C5')) { await reset(page, ['- a']); await putCaret(page, 0, 3); await key(page, 'Tab'); await key(page, 'Enter'); await type(page, 'x'); await key(page, 'Enter'); await type(page, 'y');
    check('C5 Tab indents, Enter keeps indent', JSON.stringify(await txt(page)) === JSON.stringify(['  - a', '  - x', '  - y']), await txt(page)); }
  if (want('C6')) { await reset(page, ['1. a']); await putCaret(page, 0, 4); await key(page, 'Tab');
    check('C6 Tab on numbered list', join(await txt(page)) === '  1. a', await txt(page)); }
  if (want('C7')) { await reset(page, ['  - a']); await putCaret(page, 0, 5); await key(page, 'Tab', { shiftKey: true });
    check('C7 Shift+Tab outdents', join(await txt(page)) === '- a', await txt(page)); }
  if (want('C8')) { await reset(page, ['plain']); await putCaret(page, 0, 5); await key(page, 'Tab');
    check('C8 Tab on plain text does nothing (no indent)', join(await txt(page)) === 'plain', await txt(page)); }
  if (want('C9')) { await reset(page, ['- a', '- b']); await putCaret(page, 1, 3); await key(page, 'Enter');
    check('C9 Enter at end of list item continues list', join(await txt(page)) === '- a ⏎ - b ⏎ - ', await txt(page)); }

  /* ---------------- D. checkbox ---------------- */
  if (want('D')) {
    await reset(page, ['- [ ] a', '- [x] b']);
    const cls = await page.evaluate(() => [...document.querySelectorAll('#ed > *')].map(l => l.className));
    check('D0 checked/unchecked classes parsed', cls[0].includes('done') === false && cls[1].includes('done') === true, cls);
    const p = await page.evaluate(() => { const g = document.querySelectorAll('#ed > *')[0].querySelector('[data-c]'); const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(p.x, p.y);
    check('D1 click toggles checkbox on', (await txt(page))[0] === '- [x] a', await txt(page));
    const p2 = await page.evaluate(() => { const g = document.querySelectorAll('#ed > *')[1].querySelector('[data-c]'); const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(p2.x, p2.y);
    check('D2 click toggles checkbox off', (await txt(page))[1] === '- [ ] b', await txt(page));
    const mk = await page.evaluate(() => {
      const ls = document.querySelectorAll('#ed > *');
      const g = el => { const s = getComputedStyle(el.querySelector('[data-c]')); return { size: s.fontSize, before: getComputedStyle(el.querySelector('[data-c]'), '::before').content }; };
      return { act: ls[0].classList.contains('act'), d0: g(ls[0]), d1: g(ls[1]) };
    });
    check('D3 marker shown as glyph on inactive line, raw text on active line', mk.act && mk.d1.size === '0px' && mk.d1.before.includes('☐') && mk.d0.size !== '0px', mk);
  }

  /* ---------------- E. hr ---------------- */
  if (want('E')) {
    await reset(page, ['x']); await putCaret(page, 0, 1); await type(page, ' /hr'); await key(page, 'Enter');
    check('E1 hr inserted below + empty line after', join(await txt(page)) === 'x ⏎ --- ⏎ ', await txt(page));
    await reset(page, ['']); await type(page, '/hr'); await key(page, 'Enter');
    check('E2 hr on empty line replaces it', join(await txt(page)) === '--- ⏎ ', await txt(page));
  }

  /* ---------------- F. palette ---------------- */
  if (want('F')) {
    await reset(page, ['']); await putCaret(page, 0, 0); await type(page, '/zz');
    check('F1 unknown query → palette hidden, text kept', (await sl(page)).hidden === true, await sl(page));
    await reset(page, ['']); await putCaret(page, 0, 0); await type(page, '/'); await type(page, 'zz');
    check('F2 palette closes when nothing matches', (await sl(page)).hidden === true, await sl(page));
    await reset(page, ['']); await putCaret(page, 0, 0); await type(page, '/');
    let s = await sl(page); const n0 = s.items.length;
    check('F3 palette shows all commands', !s.hidden && n0 === 12, s.items);
    await key(page, 'ArrowDown'); await key(page, 'ArrowDown'); s = await sl(page);
    check('F4 ArrowDown moves selection', s.sel === 2, s.sel);
    await key(page, 'ArrowUp'); check('F5 ArrowUp moves back', (await sl(page)).sel === 1);
    await key(page, 'ArrowUp'); await key(page, 'ArrowUp'); check('F6 wraps to end', (await sl(page)).sel === n0 - 1);
    await key(page, 'Enter');
    check('F7 Enter applies wrapped-around selection (Date)', /^\d{1,2} \w+ \d{4}$/.test((await txt(page))[0]), await txt(page));
    await reset(page, ['']); await putCaret(page, 0, 0); await type(page, '/date'); await key(page, 'Enter');
    check('F8 date command inserts french date', /^\d{1,2} \w+ \d{4}$/.test((await txt(page))[0]), await txt(page));
    await reset(page, ['']); await putCaret(page, 0, 0); await type(page, '/'); await key(page, 'Escape');
    check('F9 Escape closes palette, keeps "/"', (await txt(page))[0] === '/', await txt(page));
    // Tab in palette selects
    await reset(page, ['']); await putCaret(page, 0, 0); await type(page, '/');
    await key(page, 'Tab');
    check('F10 Tab applies command from palette', (await txt(page))[0] !== '/' && (await sl(page)).hidden, { t: (await txt(page))[0], sl: (await sl(page)).hidden });
  }

  /* ---------------- G. typing / editing ---------------- */
  if (want('G')) {
    await reset(page, ['abc']); await putCaret(page, 0, 3); await type(page, 'd');
    check('G1 typing at end', (await txt(page))[0] === 'abcd', await txt(page));
    await putCaret(page, 0, 1); await type(page, 'X');
    check('G2 typing mid-line keeps caret advancing', (await txt(page))[0] === 'aXbcd', await txt(page));
    await reset(page, ['abc']); await putCaret(page, 0, 3); await type(page, '**x**');
    const h = await page.evaluate(() => document.querySelector('#ed > *').innerHTML);
    check('G3 bold renders', h.includes('<b>x</b>'), h);
    await reset(page, ['abc']); await putCaret(page, 0, 3); await type(page, ' `a<b>&c`');
    const t = (await txt(page))[0];
    check('G4 html in source not interpreted', t === 'abc `a<b>&c`', t);
    await reset(page, ['abc']); await putCaret(page, 0, 3); await type(page, '<img src=x onerror=alert(1)>');
    check('G5 pasted html kept as text', (await txt(page))[0] === 'abc<img src=x onerror=alert(1)>' && (await page.evaluate(() => document.querySelectorAll('#ed img').length)) === 0, await txt(page));
    await reset(page, ['abc']); await putCaret(page, 0, 3); await type(page, ' *unbalanced');
    const h2 = await page.evaluate(() => document.querySelector('#ed > *').innerHTML);
    check('G6 lone * not italicised', !h2.includes('<i>'), h2);
  }

  /* ---------------- H. paste ---------------- */
  if (want('H')) {
    await reset(page, ['']); await putCaret(page, 0, 0);
    await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'un\n- deux\n## trois'); document.querySelector('#ed').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    check('H1 multiline paste creates lines', join(await txt(page)) === 'un ⏎ - deux ⏎ ## trois', await txt(page));
    await reset(page, ['abc']); await putCaret(page, 0, 1);
    await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'X\nY'); document.querySelector('#ed').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    check('H2 paste splits mid-line correctly', join(await txt(page)) === 'aX ⏎ Ybc', await txt(page));
  }

  /* ---------------- I. persistence ---------------- */
  if (want('I')) {
    await reset(page, ['# T', 'corps **g**', '- [x] fait']);
    await new Promise(r => setTimeout(r, 600));
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 500));
    check('I1 content persists after reload', join(await txt(page)) === '# T ⏎ corps **g** ⏎ - [x] fait', await txt(page));
    const cls = await page.evaluate(() => [...document.querySelectorAll('#ed > *')].map(l => l.className));
    check('I2 markers re-parsed on reload', cls[0].includes('h1') && cls[2].includes('done'), cls);
  }

  /* ---------------- J. TOC ---------------- */
  if (want('J')) {
    await reset(page, ['# A', 'un deux trois', '## B', 'quatre cinq', '### C', 'six']);
    await new Promise(r => setTimeout(r, 400));
    await page.click('#bToc');
    const toc = await page.evaluate(() => [...document.querySelectorAll('#tocList .t')].map(b => b.textContent));
    check('J1 TOC word counts', toc.length === 3 && toc[0].includes('A · 3 m') && toc[1].includes('B · 2 m') && toc[2].includes('C · 1 m'), toc);
    await reset(page, ['rien']);
    await new Promise(r => setTimeout(r, 400));
    await page.click('#bToc');
    check('J2 TOC empty state', await page.evaluate(() => !!document.querySelector('#tocList .empty')));
  }

  /* ---------------- K. export ---------------- */
  if (want('K')) {
    const grab = id => page.evaluate(i => new Promise(res => {
      const orig = URL.createObjectURL, oc = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { };
      URL.createObjectURL = b => { b.text().then(t => { URL.createObjectURL = orig; HTMLAnchorElement.prototype.click = oc; res(t); }); return 'blob:x'; };
      document.querySelector(i).click();
    }), id);
    await reset(page, ['# T', '', '- [ ] a', '- [x] b', '  - nest', '1. x', '2. y', '', '> q', '', '---', '', '**b** *i*']);
    await new Promise(r => setTimeout(r, 400));
    const html = await grab('#bHtml');
    fsx.writeFileSync(path.join(ART, 'export.html'), html);
    const txtOut = await grab('#bTxt');
    fsx.writeFileSync(path.join(ART, 'export.txt'), txtOut);
    const json = await grab('#bJson');
    console.log('\n--- toHtml ---\n' + (html.match(/<body>[\s\S]*?<\/body>/) || ['?'])[0]);
    console.log('\n--- plain ---\n' + txtOut);
    const md = await grab('#bMd');
    check('K1 export md = raw source', md.includes('**b** *i*'), md.slice(0, 80));
    check('K2 export json parses', Array.isArray(JSON.parse(json)) && JSON.parse(json).length >= 1);
    check('K3 plain strips markers', txtOut.includes('☐ a') && txtOut.includes('☑ b') && txtOut.includes('  • nest') && txtOut.includes('———') && txtOut.includes('b i') && !txtOut.includes('- ['), txtOut);
    check('K4 html has checkbox inputs', (html.match(/type="checkbox"/g) || []).length === 2, html);
  }

  /* ---------------- L. docs ---------------- */
  if (want('L')) {
    const curId = () => page.evaluate(() => { const b = document.querySelector('#list .doc.cur'); return b && b.__id; });
    const showList = async () => { await page.evaluate(() => document.querySelector('#bDocs').click()); await new Promise(r => setTimeout(r, 150)); };
    // repartir d'un jeu de documents connu : on supprime tous les documents un par un
    const wipe = async () => {
      await showList();
      let guard = 0;
      while (await page.evaluate(() => document.querySelectorAll('#list .row').length) > 0 && guard++ < 30) {
        await page.evaluate(() => {
          const rows = [...document.querySelectorAll('#list .row')];
          const r = rows.find(x => x.querySelector('.doc').classList.contains('cur')) || rows[0];
          const b = r.querySelector('.ib'); b.click(); b.click();
        });
        await new Promise(r => setTimeout(r, 250));
      }
      await showList();
    };

    await reset(page, ['# T', 'corps **g**', '- [x] fait']);
    await new Promise(r => setTimeout(r, 500));
    const DOC1 = join(await txt(page));
    // la liste est triée : on cible le document par son ID, pas par sa position
    const doc1Id = await curId();

    await showList();
    await page.evaluate(() => document.querySelector('#bNew').click());
    await new Promise(r => setTimeout(r, 250));
    await putCaret(page, 0, 0); await type(page, 'second doc');
    await new Promise(r => setTimeout(r, 500));

    await showList();
    await page.evaluate(id => {
      const rows = [...document.querySelectorAll('#list .doc')];
      const target = rows.find(b => b.__id === id);
      (target || rows[0]).click();
    }, doc1Id);
    await new Promise(r => setTimeout(r, 300));
    const back = join(await txt(page));
    check('L1 switch back to doc 1', back === DOC1, { back, DOC1, doc1Id });
    await page.evaluate(() => document.querySelector('#bDocs').click());
    await new Promise(r => setTimeout(r, 120));
    const before = await page.evaluate(() => document.querySelectorAll('#list .row').length);
    await page.evaluate(() => document.querySelectorAll('#list .row .ib')[1].click());
    const armed = await page.evaluate(() => document.querySelectorAll('#list .row .ib')[1].textContent);
    await new Promise(r => setTimeout(r, 100));
    await page.evaluate(() => document.querySelectorAll('#list .row .ib')[1].click());
    await new Promise(r => setTimeout(r, 300));
    const after = await page.evaluate(() => document.querySelectorAll('#list .row').length);
    check('L2 two-step delete removes the right doc', before === after + 1 && armed === 'sûr ?', { before, after, armed });
    await page.evaluate(() => document.querySelector('#bDocs').click());
    await new Promise(r => setTimeout(r, 100));
    // delete every doc -> must keep one usable doc
    let guard = 0;
    while (await page.evaluate(() => document.querySelectorAll('#list .row').length) > 1 && guard++ < 10) {
      await page.evaluate(() => { const r = document.querySelectorAll('#list .row'); const b = r[r.length - 1].querySelector('.ib'); b.click(); b.click(); });
      await new Promise(r => setTimeout(r, 250));
    }
    const last = await page.evaluate(() => ({ rows: document.querySelectorAll('#list .row').length, lines: document.querySelectorAll('#ed > *').length, cur: !!localStorage.getItem('mwd:cur') }));
    check('L3 deleting all-but-one leaves valid state', last.rows === 1 && last.lines >= 1 && last.cur, last);
    await page.reload({ waitUntil: 'networkidle2' }); await new Promise(r => setTimeout(r, 500));
    check('L4 editor not empty after deleting all docs', (await page.evaluate(() => document.querySelectorAll('#ed > *').length)) >= 1, await txt(page));
  }

  /* ---------------- M. title ---------------- */
  if (want('M')) {
    await page.evaluate(() => { const t = document.querySelector('#title'); t.value = 'Mon titre'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise(r => setTimeout(r, 500));
    await page.reload({ waitUntil: 'networkidle2' }); await new Promise(r => setTimeout(r, 500));
    check('M1 title persists', await page.evaluate(() => document.querySelector('#title').value) === 'Mon titre');
    await page.evaluate(() => { const t = document.querySelector('#title'); t.value = '<img src=x onerror=alert(1)>'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise(r => setTimeout(r, 300));
    check('M2 title escaped in doc list', await page.evaluate(() => document.querySelectorAll('#list img').length) === 0);
    check('M3 doc list shows title text', await page.evaluate(() => document.querySelector('#list').textContent.includes('<img src=x onerror=alert(1)>')));
  }

  /* ---------------- N. idle / theme ---------------- */
  if (want('N')) {
    await page.evaluate(() => { const s = document.querySelector('#idle'); s.value = '3000'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.evaluate(() => document.querySelector('#ed').focus());
    await page.mouse.move(300, 300);
    await new Promise(r => setTimeout(r, 3700));
    const on = await page.evaluate(() => document.body.classList.contains('idle'));
    await page.mouse.move(320, 320);
    const off = await page.evaluate(() => document.body.classList.contains('idle'));
    check('N1 idle hides then restores UI', on && !off, { on, off });
    await page.evaluate(() => document.querySelector('#bTheme').click());
    const th = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.reload({ waitUntil: 'networkidle2' }); await new Promise(r => setTimeout(r, 400));
    check('N2 theme persists', await page.evaluate(() => document.documentElement.dataset.theme) === th, { th, now: await page.evaluate(() => document.documentElement.dataset.theme) });
  }

  /* ---------------- O. import ---------------- */
  if (want('O')) {
    const imported = await page.evaluate(() => new Promise(res => {
      const dt = new DataTransfer();
      dt.items.add(new File(['# Importé\n\nligne'], 'note.md', { type: 'text/markdown' }));
      const fi = document.querySelector('#file');
      fi.files = dt.files;
      fi.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => res([...document.querySelectorAll('#ed > *')].map(l => l.textContent)), 700);
    }));
    check('O1 import .md creates doc', JSON.stringify(imported) === '["# Importé","","ligne"]', imported);
    const importedJson = await page.evaluate(() => new Promise(res => {
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify([{ title: 'J1', content: 'a' }, { title: 'J2', content: 'b' }])], 'x.json', { type: 'application/json' }));
      const fi = document.querySelector('#file');
      fi.files = dt.files;
      fi.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => res({ lines: [...document.querySelectorAll('#ed > *')].map(l => l.textContent), docs: document.querySelectorAll('#list .row').length, title: document.querySelector('#title').value }), 700);
    }));
    check('O2 import .json creates 2 docs, opens last', importedJson.docs >= 3 && importedJson.title === 'J2' && JSON.stringify(importedJson.lines) === '["b"]', importedJson);
    const badImport = await page.evaluate(() => new Promise(res => {
      const dt = new DataTransfer();
      dt.items.add(new File(['{not json'], 'x.json', { type: 'application/json' }));
      const fi = document.querySelector('#file');
      fi.files = dt.files;
      fi.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => res({ docs: document.querySelectorAll('#list .row').length }), 600);
    }));
    check('O3 malformed json import does not corrupt', badImport.docs >= 1, badImport);
  }

  /* ---------------- T. tri, recherche, À propos, dossier ---------------- */
  if (want('T')) {
    const sortVal = () => page.evaluate(() => document.querySelector('#sort').value);
    const showList = async () => { await page.evaluate(() => document.querySelector('#bDocs').click()); await new Promise(r => setTimeout(r, 150)); };
    // repartir d'un jeu de documents connu : on supprime TOUS les documents.
    // Dernier document Impossible à supprimer (l'app en recrée un), on le renomme.
    const wipe = async () => {
      await showList();
      let guard = 0;
      while (await page.evaluate(() => document.querySelectorAll('#list .row').length) > 1 && guard++ < 30) {
        await page.evaluate(() => {
          const rows = [...document.querySelectorAll('#list .row')];
          const r = rows.find(x => x.querySelector('.doc').classList.contains('cur')) || rows[0];
          const b = r.querySelector('.ib'); b.click(); b.click();
        });
        await new Promise(r => setTimeout(r, 250));
      }
      // le survivant : on le neutralise pour ne pas polluer les attentes
      await page.evaluate(() => {
        const cur = [...document.querySelectorAll('#list .doc')].find(b => b.classList.contains('cur'));
        if (!cur) return;
        cur.click();
      });
      await new Promise(r => setTimeout(r, 250));
      await page.evaluate(() => {
        const i = document.querySelector('#title');
        i.value = 'zzzignore'; i.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await new Promise(r => setTimeout(r, 250));
      await showList();
    };
    // titre utile = tout sauf le document neutre.
    // Le bouton contient le titre PUIS un <small>« n m » : on lit le nœud texte
    // du titre seul, sinon « note10 » se retrouve collé à « 3 m ».
    const realTitles = () => page.evaluate(() =>
      [...document.querySelectorAll('#list .doc')]
        .map(b => [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim())
        .filter(t => t !== 'zzzignore'));

    await wipe();

    // jeu de documents : un par un via l'UI (bouton « + Nouveau document » + titre)
    const addDoc = async (titre, contenu) => {
      await page.evaluate(() => { document.querySelector('#bDocs').click(); });
      await new Promise(r => setTimeout(r, 150));
      await page.evaluate(() => document.querySelector('#bNew').click());
      await new Promise(r => setTimeout(r, 300));
      await page.evaluate(t => {
        const inp = document.querySelector('#title');
        inp.value = t;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }, titre);
      if (contenu) {
        await putCaret(page, 0, 0);
        await type(page, contenu);
      }
      await page.evaluate(() => document.querySelector('#bDocs').click());
      await new Promise(r => setTimeout(r, 200));
    };

    await addDoc('Zeta', 'premier contenu zzz');
    await addDoc('Alpha', 'contenu de alpha');
    await addDoc('Moyen', 'ici parle de algo');
    await addDoc('Doc Algo', 'Algorithme de tri');
    const titles = realTitles;
    // le tri se pilote comme un utilisateur : choisir la clé, puis le sens
    const setSort = async (key, dir) => {
      await page.evaluate(k => {
        const s = document.querySelector('#sort');
        const o = [...s.options].find(x => x.value.split(':')[0] === k && !x.hidden);
        if (!o) throw new Error('option de tri absente: ' + k);
        s.value = o.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, key);
      await new Promise(r => setTimeout(r, 150));
      const want = dir === 'asc' ? '↑' : '↓';
      const cur = await page.evaluate(() => document.querySelector('#sortdir').textContent);
      if (cur !== want) {
        await page.evaluate(() => document.querySelector('#sortdir').click());
        await new Promise(r => setTimeout(r, 150));
      }
    };

    await showList();
    await setSort('name', 'asc');
    const byName = await titles();
    check('T1 tri par nom', JSON.stringify(byName) === JSON.stringify(['Alpha', 'Doc Algo', 'Moyen', 'Zeta']), byName);

    await setSort('name', 'desc');
    const byNameDesc = await titles();
    check('T2 tri inversé', JSON.stringify(byNameDesc) === JSON.stringify(['Zeta', 'Moyen', 'Doc Algo', 'Alpha']), byNameDesc);

    // --- le tri persiste (clé ET sens)
    await new Promise(r => setTimeout(r, 600));
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 600));
    const persisted = await page.evaluate(() => ({ v: document.querySelector('#sort').value, d: document.querySelector('#sortdir').textContent }));
    check('T3 tri conservé après rechargement', persisted.v.startsWith('name:') && persisted.d === '↓', persisted);
    await showList();

    // --- tri par nom naturel (note2 avant note10)
    await wipe();
    await addDoc('note10', 'a');
    await addDoc('note2', 'b');
    await addDoc('note1', 'c');
    await showList();
    await setSort('name', 'asc');
    const nat = await titles();
    check('T4 tri naturel (note2 < note10)', JSON.stringify(nat) === JSON.stringify(['note1', 'note2', 'note10']), nat);

    // --- retour au jeu complet pour la recherche et le panneau À propos
    await wipe();
    await addDoc('Zeta', 'premier contenu zzz');
    await addDoc('Alpha', 'contenu de alpha');
    await addDoc('Moyen', 'ici parle de algo');
    await addDoc('Doc Algo', 'Algorithme de tri');
    await showList();

    // --- recherche
    await page.evaluate(() => { const q = document.querySelector('#q'); q.value = 'Algorithme'; q.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise(r => setTimeout(r, 200));
    const res = await page.evaluate(() => ({
      visible: !document.querySelector('#results').hidden,
      listHidden: document.querySelector('#list').hidden,
      titles: [...document.querySelectorAll('#results .res b')].map(b => b.textContent),
      snippet: (document.querySelector('#results .res span') || {}).textContent || '',
    }));
    check('T5 recherche filtre et affiche un snippet', res.visible && res.listHidden && res.titles.includes('Doc Algo') && res.snippet.includes('Algo'), res);

    // --- Échap vide la recherche
    await page.evaluate(() => { const q = document.querySelector('#q'); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await new Promise(r => setTimeout(r, 150));
    check('T6 Échap vide la recherche', await page.evaluate(() => document.querySelector('#q').value === '' && document.querySelector('#list').hidden === false), await page.evaluate(() => ({ v: document.querySelector('#q').value, lh: document.querySelector('#list').hidden })));

    // --- recherche sans résultat
    await page.evaluate(() => { const q = document.querySelector('#q'); q.value = 'zzzzintrouvable'; q.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise(r => setTimeout(r, 150));
    check('T7 recherche sans résultat', await page.evaluate(() => document.querySelector('#results').textContent.includes('Aucun résultat')));

    // --- cliquer un résultat ouvre le bon document
    await page.evaluate(() => { const q = document.querySelector('#q'); q.value = 'Algorithme'; q.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => document.querySelectorAll('#results .res')[0].click());
    await new Promise(r => setTimeout(r, 300));
    const opened = await page.evaluate(() => ({ t: document.querySelector('#title').value, panel: !document.querySelector('#docs').classList.contains('open') }));
    check('T8 clic sur un résultat ouvre le document et ferme le tiroir', opened.t === 'Doc Algo' && opened.panel, opened);

    // --- panneau À propos
    await page.evaluate(() => document.querySelector('#bDocs').click());
    await new Promise(r => setTimeout(r, 150));
    await page.evaluate(() => document.querySelector('#bAbout').click());
    await new Promise(r => setTimeout(r, 250));
    const about = await page.evaluate(() => ({
      open: document.querySelector('#about').classList.contains('open'),
      docsClosed: !document.querySelector('#docs').classList.contains('open'),
      text: document.querySelector('#aboutC').textContent,
      links: [...document.querySelectorAll('#aboutC a')].map(a => a.getAttribute('href')),
      version: document.querySelector('#aboutC b').textContent,
      cmds: document.querySelectorAll('#aboutC div div').length,
    }));
    check('T9 panneau À propos ouvert, tiroir Documents fermé', about.open && about.docsClosed, about);
    check('T10 liens GitHub corrects', about.links.includes('https://github.com/Tahlasandale/writerr') && about.links.includes('https://github.com/Tahlasandale/writerr/releases/latest') && about.links.includes('https://github.com/Tahlasandale/writerr/issues'), about.links);
    check('T11 version affichée = WD_CONFIG', about.version === '0.1.0', about.version);
    check('T12 raccourcis et commandes listés', /Entrée/.test(about.text) && /Titre 1/.test(about.text) && /Case à cocher/.test(about.text), about.text.slice(0, 200));
    check('T13 aucun lien OWNER', !about.links.some(h => /OWNER/.test(h || '')), about.links);

    // --- import d'un dossier de .md
    const imported = await page.evaluate(() => new Promise(res => {
      const dt = new DataTransfer();
      // webkitRelativePath se définit sur le File, pas sur le FileItem du DataTransfer
      const mk = (relPath, content, type) => {
        const f = new File([content], relPath.split('/').pop(), { type: type || 'text/markdown' });
        Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
        dt.items.add(f);
      };
      mk('Notes/racine.md', '# Racine');
      mk('Notes/Sous/deep.md', 'du contenu');
      mk('Notes/ignore.txt', 'ignoré', 'text/plain');
      const fi = document.querySelector('#folderInput');
      fi.files = dt.files;
      fi.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => res({
        titles: [...document.querySelectorAll('#list .doc')]
          .map(b => [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()),
      }), 1400);
    }));
    // on isole les titres ajoutés par cet import (le document neutre existe déjà)
    const added = imported.titles.filter(t => ['racine', 'Sous / deep', 'ignore', 'Notes / racine'].includes(t));
    check('T14 import de dossier : .md seulement, racine omise, sous-dossier dans le titre',
      added.includes('racine')
      && added.includes('Sous / deep')
      && !added.includes('ignore')        /* le .txt est ignoré */
      && !added.includes('Notes / racine')/* la racine n'est pas dans le titre */
      && !added.some(t => /\.md$/i.test(t)),/* extension retirée */
      { added, all: imported.titles });

    // --- le document importé est recherchable PAR SON CONTENU (« # Racine »)
    const found = await page.evaluate(() => new Promise(res => {
      const q = document.querySelector('#q');
      q.value = 'Racine';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => res([...document.querySelectorAll('#results .res b')].map(b => b.textContent)), 300);
    }));
    check('T15 document importé trouvé par son contenu', found.some(t => /racine/i.test(t)), found);

    // --- et par son titre de fichier
    const byPath = await page.evaluate(() => new Promise(res => {
      const q = document.querySelector('#q');
      q.value = 'Sous'; q.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => res([...document.querySelectorAll('#results .res b')].map(b => b.textContent)), 300);
    }));
    check('T16 document importé trouvé par un mot de son chemin de dossier', byPath.some(t => /deep/.test(t)), byPath);

    await page.evaluate(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => document.querySelector('#scrim').click());
    await new Promise(r => setTimeout(r, 150));
  }

  /* ---------------- P. escape then leave / re-enter the token ---------------- */
  if (want('P')) {
    await reset(page, ['abc']); await putCaret(page, 0, 3); await type(page, ' /h');
    check('P1 palette open before Escape', !(await sl(page)).hidden, await sl(page));
    await key(page, 'Escape');
    check('P2 Escape closes palette', (await sl(page)).hidden);
    await type(page, '1');
    check('P3 stays closed while typing in the same token', (await sl(page)).hidden);
    await putCaret(page, 0, 1);
    await putCaret(page, 0, 11); await type(page, ' /h');
    check('P4 menu works again after leaving the dismissed token', !(await sl(page)).hidden, await sl(page));
  }

  /* ---------------- Q. doc switch resets scroll ---------------- */
  if (want('Q')) {
    await reset(page, Array.from({ length: 25 }, (_, i) => 'ligne ' + (i + 1)));
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => document.querySelector('#scroll').scrollTo(0, 9999));
    const scrolled = await page.evaluate(() => document.querySelector('#scroll').scrollTop);
    await page.evaluate(() => { document.querySelector('#bDocs').click(); document.querySelector('#bNew').click(); });
    await new Promise(r => setTimeout(r, 300));
    const after = await page.evaluate(() => document.querySelector('#scroll').scrollTop);
    check('Q1 new document starts at the top', scrolled > 0 && after === 0, { scrolled, after });
  }

  /* ---------------- R. import .txt ---------------- */
  if (want('R')) {
    const t = await page.evaluate(() => new Promise(res => {
      const dt = new DataTransfer();
      dt.items.add(new File(['ligne 1\nligne 2'], 'n.txt', { type: 'text/plain' }));
      const fi = document.querySelector('#file'); fi.files = dt.files; fi.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => res({ lines: [...document.querySelectorAll('#ed > *')].map(l => l.textContent), title: document.querySelector('#title').value }), 700);
    }));
    check('R1 import .txt creates a document', JSON.stringify(t.lines) === '["ligne 1","ligne 2"]' && t.title === 'n', t);
  }

  /* ---------------- S. localStorage fallback (no IndexedDB) ---------------- */
  if (want('S')) {
    const p2 = await browser.newPage();
    await p2.evaluateOnNewDocument(() => { Object.defineProperty(window, 'indexedDB', { get: () => { throw new Error('blocked'); } }); });
    await p2.goto(BASE + '/web/index.html', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 500));
    const boot = await p2.evaluate(() => ({ lines: document.querySelectorAll('#ed > *').length, docs: document.querySelectorAll('#list .row').length }));
    check('S1 boots without IndexedDB', boot.lines > 1, boot);
    await p2.evaluate(() => { document.querySelector('#ed').focus(); const l = document.querySelector('#ed > *'); const r = document.createRange(); r.selectNodeContents(l); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await p2.evaluate(() => document.execCommand('insertText', false, 'FALLBACK'));
    await new Promise(r => setTimeout(r, 600));
    await p2.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 600));
    const kept = await p2.evaluate(() => ({ first: document.querySelector('#ed > *').textContent, ls: !!localStorage.getItem('mwd:docs') }));
    check('S2 persists via localStorage when IndexedDB is missing', kept.ls && kept.first.startsWith('# Bienvenue'), kept);
    await p2.close();
  }

  console.log('\n=== PAGE ERRORS ===\n' + (errs.join('\n') || '(none)'));
  const bad = R.filter(r => !r.ok).map(r => r.n);
  console.log(`\n=== ${R.length - bad.length}/${R.length} passed ===`);
  if (bad.length) console.log('FAILED: ' + bad.join(' | '));
  await browser.close();
  await server.close();
  process.exitCode = (bad.length || errs.length) ? 1 : 0;
})().catch(async e => { console.error('FATAL', e); if (globalThis.__wdServer) await globalThis.__wdServer.close(); process.exit(1); });