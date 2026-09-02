// カレンダー変化監視ボット
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import 'dotenv/config';

const SITE = {
  agendaUrl:   process.env.PM_URL || '',
  userSel:     'input[type="text"], input[name*="user" i], input[name*="login" i]',
  passSel:     'input[type="password"]',
  submitSel:   'input[type="submit"][value*="Log" i], button[type="submit"]',
  monthViewSel:'text=Maand',
  nextBtnSel:  "a[id$='_btnNext']",
  prevBtnSel:  "a[id$='_btnPrev']",
  dayCellSel:  '.monthdayemp',
};

const CFG = {
  user:        process.env.PM_USER || '',
  pass:        process.env.PM_PASS || '',
  monthsAhead: parseInt(process.env.PM_MONTHS_AHEAD || '14', 10),
  lineToken:   process.env.LINE_TOKEN || '',
  lineTo:      (process.env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean),
  heartbeatTo: (process.env.LINE_TO_HEARTBEAT || '').split(',').map(s => s.trim()).filter(Boolean),
  headless:    (process.env.PM_HEADLESS || 'true') !== 'false',
  dataDir:     process.env.PM_DATA_DIR || '.',
};

const SEEN_FILE = path.join(CFG.dataDir, 'seen.json');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

function loadPrev() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveCurrent(set) { fs.writeFileSync(SEEN_FILE, JSON.stringify([...set])); }

async function lineNotify(text, toList) {
  if (!CFG.lineToken) { log('[LINE未設定]'); return; }
  const targets = (toList && toList.length) ? toList : CFG.lineTo;
  const send = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.lineToken },
      body: JSON.stringify(body),
    });
    if (!res.ok) log('LINE送信失敗', res.status);
    else log('LINE送信OK');
  };
  if (targets.length) {
    for (const to of targets) {
      await send('https://api.line.me/v2/bot/message/push', { to, messages: [{ type: 'text', text }] });
    }
  } else {
    await send('https://api.line.me/v2/bot/message/broadcast', { messages: [{ type: 'text', text }] });
  }
}

async function isLoggedOut(page) {
  return (await page.locator(SITE.passSel).count().catch(() => 0)) > 0;
}

async function login(page) {
  if (!SITE.agendaUrl) throw new Error('PM_URL未設定');
  log('ページを開く...');
  await page.goto(SITE.agendaUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1000);
  if (await isLoggedOut(page)) {
    log('ログイン中...');
    await page.locator(SITE.userSel).first().fill(CFG.user);
    await page.locator(SITE.passSel).first().fill(CFG.pass);
    let done = false;
    try {
      const b = page.locator(SITE.submitSel).first();
      if (await b.count()) { await b.click({ timeout: 3000 }); done = true; }
    } catch {}
    if (!done) { try { await page.getByText(/log\s*in/i).first().click({ timeout: 3000 }); done = true; } catch {} }
    if (!done) { try { await page.locator(SITE.passSel).first().press('Enter'); } catch {} }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
    await page.goto(SITE.agendaUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(800);
  }
  if (await isLoggedOut(page)) throw new Error('ログインに失敗しました');
}

async function ensureMonthView(page) {
  try { await page.locator(SITE.monthViewSel).first().click({ timeout: 3000 }); } catch {}
  await page.waitForTimeout(800);
}

async function readMonthText(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('div[onclick*="showquicknavigation"]');
    return el ? el.innerText.trim() : '';
  });
}

async function scanMonth(page) {
  return await page.evaluate((sel) => {
    const monthEl = document.querySelector('div[onclick*="showquicknavigation"]');
    const monthText = monthEl ? monthEl.innerText.trim() : '';
    const seenCells = new Set();
    const cells = [];
    for (const el of document.querySelectorAll(sel)) {
      const header = el.querySelector('.day_header');
      if (!header) continue;
      const day = header.innerText.trim().split('|')[0].trim();
      if (!day || seenCells.has(day)) continue;
      seenCells.add(day);
      const all = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const body = all.replace(header.innerText.replace(/\s+/g, ' ').trim(), '').trim();
      if (body) cells.push({ month: monthText, day, body }); // 予定が入っている日だけ
    }
    return { monthText, cells };
  }, SITE.dayCellSel);
}

// 「月の表示が変わるまで」確認しながら次の月へ進む
async function gotoNextMonth(page, prevMonthText) {
  await page.locator(SITE.nextBtnSel).first().click({ timeout: 5000 });
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const now = await readMonthText(page);
    if (now && now !== prevMonthText) return now;
  }
  throw new Error('月送りが反映されませんでした');
}

async function sweepMonths(page) {
  await ensureMonthView(page);
  const found = [];
  const monthsSeen = [];
  let monthText = await readMonthText(page);
  for (let i = 0; i <= CFG.monthsAhead; i++) {
    const r = await scanMonth(page);
    monthsSeen.push(r.monthText);
    for (const c of r.cells) found.push(c);
    log(`  ${r.monthText}: 予定あり${r.cells.length}日`);
    if (i < CFG.monthsAhead) monthText = await gotoNextMonth(page, monthText);
  }
  const distinct = new Set(monthsSeen).size;
  if (distinct < CFG.monthsAhead + 1) {
    throw new Error(`月の取得が不完全(${distinct}/${CFG.monthsAhead + 1})`);
  }
  return found;
}

async function collect(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await login(page);
    return await sweepMonths(page);
  } finally {
    await ctx.close();
  }
}

async function runCheckCycle(found) {
  const prev = loadPrev();
  const current = new Set(found.map(c => hash(`${c.month}|${c.day}|${c.body}`)));

  if (prev.size === 0) {
    saveCurrent(current);
    log(`初回: 予定あり${found.length}日を基準として記録(通知なし)`);
    return;
  }

  const fresh = found.filter(c => !prev.has(hash(`${c.month}|${c.day}|${c.body}`)));
  saveCurrent(current);

  if (fresh.length) {
    const days = [...new Set(fresh.map(c => `${c.month} ${c.day}`))];
    await lineNotify('📢 スケジュールに変化あり\n' + days.map(d => `・${d}`).join('\n'));
  } else {
    log('変化なし');
  }
}

async function heartbeat(browser) {
  const found = await collect(browser);
  await lineNotify(
    `✅ 監視は正常に動いています\n` +
    `・${CFG.monthsAhead + 1}ヶ月分をチェック中\n` +
    `・予定が入っている日：${found.length}日`,
    CFG.heartbeatTo
  );
}

async function main() {
  const mode =
    process.argv.includes('--testline')  ? 'testline'  :
    process.argv.includes('--heartbeat') ? 'heartbeat' : 'once';

  if (mode === 'testline') {
    await lineNotify('✅ テスト通知');
    return;
  }

  const browser = await chromium.launch({ headless: CFG.headless });
  try {
    if (mode === 'heartbeat') { await heartbeat(browser); return; }
    await runCheckCycle(await collect(browser));
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
