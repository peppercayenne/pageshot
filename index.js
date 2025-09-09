// index.js
// Express + Playwright — Amazon minimal-stealth scraper with captcha handling & 2Captcha
// Scrapes: title, brand, itemForm, price (first instance), mainImageUrl
//
// GET /scrape?url=...
//
// Env:
//   PORT=8080
//   TWO_CAPTCHA_KEY=your_2captcha_key   (only needed if you want auto-solve)

const express = require('express');
const https = require('https');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 8080;
const TWO_CAPTCHA_KEY = process.env.TWO_CAPTCHA_KEY || '';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const IN_URL = 'https://2captcha.com/in.php';
const RES_URL = 'https://2captcha.com/res.php';
const MAX_2CAPTCHA_BYTES = 100 * 1024; // 100 KB

// ---------- tiny https helpers ----------
function httpsFormPost(urlStr, formObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const body = new URLSearchParams(formObj).toString();
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function httpsGetJson(urlStr, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.append(k, v));
    const opts = {
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          if (data.startsWith('OK|')) {
            resolve({ status: 1, request: data.split('|', 2)[1] });
          } else {
            resolve({ status: 0, request: data });
          }
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- 2Captcha (text / rotate / coordinates) ----------
async function solveTextCaptcha(base64Image) {
  if (!TWO_CAPTCHA_KEY) throw new Error('TWOCAPTCHA_API_KEY not set');
  const submitRaw = await httpsFormPost(IN_URL, {
    key: TWO_CAPTCHA_KEY,
    method: 'base64',
    body: base64Image,
    json: 1,
  });
  let submit;
  try { submit = JSON.parse(submitRaw); }
  catch { submit = submitRaw.startsWith('OK|') ? { status: 1, request: submitRaw.split('|', 2)[1] } : { status: 0, request: submitRaw }; }
  if (submit.status !== 1) return { ok: false, stage: 'submit', response: submit };

  const reqId = submit.request;
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const poll = await httpsGetJson(RES_URL, { key: TWO_CAPTCHA_KEY, action: 'get', id: reqId, json: 1 });
    if (poll.status === 1) return { ok: true, captchaId: reqId, text: poll.request };
    if (poll.request !== 'CAPCHA_NOT_READY') return { ok: false, stage: 'poll', captchaId: reqId, response: poll };
  }
  return { ok: false, stage: 'timeout', captchaId: reqId };
}

// (Kept for completeness; Amazon rarely uses these)
async function solveRotateCaptcha(base64Image) {
  if (!TWO_CAPTCHA_KEY) throw new Error('TWOCAPTCHA_API_KEY not set');
  const submitRaw = await httpsFormPost(IN_URL, {
    key: TWO_CAPTCHA_KEY,
    method: 'base64',
    body: base64Image,
    json: 1,
    is_rotate: 1,
  });
  let submit;
  try { submit = JSON.parse(submitRaw); }
  catch { submit = submitRaw.startsWith('OK|') ? { status: 1, request: submitRaw.split('|', 2)[1] } : { status: 0, request: submitRaw }; }
  if (submit.status !== 1) return { ok: false, stage: 'submit', response: submit };
  const reqId = submit.request;
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const poll = await httpsGetJson(RES_URL, { key: TWO_CAPTCHA_KEY, action: 'get', id: reqId, json: 1 });
    if (poll.status === 1) return { ok: true, captchaId: reqId, angle: poll.request };
    if (poll.request !== 'CAPCHA_NOT_READY') return { ok: false, stage: 'poll', captchaId: reqId, response: poll };
  }
  return { ok: false, stage: 'timeout', captchaId: reqId };
}
async function solveCoordinatesCaptcha(base64Image) {
  if (!TWO_CAPTCHA_KEY) throw new Error('TWOCAPTCHA_API_KEY not set');
  const submitRaw = await httpsFormPost(IN_URL, {
    key: TWO_CAPTCHA_KEY,
    method: 'base64',
    body: base64Image,
    json: 1,
    coordinatescaptcha: 1,
  });
  let submit;
  try { submit = JSON.parse(submitRaw); }
  catch { submit = submitRaw.startsWith('OK|') ? { status: 1, request: submitRaw.split('|', 2)[1] } : { status: 0, request: submitRaw }; }
  if (submit.status !== 1) return { ok: false, stage: 'submit', response: submit };
  const reqId = submit.request;
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const poll = await httpsGetJson(RES_URL, { key: TWO_CAPTCHA_KEY, action: 'get', id: reqId, json: 1 });
    if (poll.status === 1) return { ok: true, captchaId: reqId, coords: poll.request };
    if (poll.request !== 'CAPCHA_NOT_READY') return { ok: false, stage: 'poll', captchaId: reqId, response: poll };
  }
  return { ok: false, stage: 'timeout', captchaId: reqId };
}

// ---------- minimal context + helpers ----------
async function minimalContext(chromium, width, height) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.setExtraHTTPHeaders({
    'accept-language': 'en-US,en;q=0.9',
    'upgrade-insecure-requests': '1',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
  });

  return { browser, context, page };
}

async function tryClickContinue(page) {
  const selectors = [
    'input[type="submit"][value*="Continue shopping" i]',
    'button:has-text("Continue shopping")',
    'input[name="continue"]',
    'button:has-text("Continue")',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el && await el.isVisible()) {
      await el.click({ delay: 40 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
      return true;
    }
  }
  // Frames too
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const el = await frame.$(sel);
      if (el && await el.isVisible()) {
        await el.click({ delay: 40 }).catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(300);
        return true;
      }
    }
  }
  return false;
}

async function isVisible(pageOrFrame, selector) {
  const el = await pageOrFrame.$(selector);
  if (!el) return false;
  return el.isVisible();
}

async function detectCase(page) {
  const url = page.url();
  const html = await page.content();

  const is503 = /503 - Service Unavailable/i.test(html);
  const is504 = /504 - Gateway Time-out/i.test(html);

  // If product title visible -> normal
  const titleVisible = await isVisible(page, '#productTitle');
  if (titleVisible) {
    const titleText = (await page.textContent('#productTitle').catch(() => ''))?.trim();
    if (titleText) {
      return { type: 'normal', signals: { titleVisible: true } };
    }
  }

  // Continue shopping?
  const contSel =
    'input[type="submit"][value*="Continue shopping" i], button:has-text("Continue shopping"), input[name="continue"]';
  if (await isVisible(page, contSel)) {
    return { type: 'continue-shopping', signals: { hasContinue: true } };
  }

  // Captcha?
  const urlLooksCaptcha = /\/errors\/validateCaptcha/i.test(url);
  const hasCaptchaForm = await isVisible(page, 'form[action*="/errors/validateCaptcha"], form[action*="validateCaptcha"]');
  const hasCaptchaInput = await isVisible(page, '#captchacharacters');
  const hasCaptchaImg = await isVisible(page, 'form[action*="validateCaptcha"] img, img[src*="captcha"]');

  if (urlLooksCaptcha || hasCaptchaForm || (hasCaptchaImg && hasCaptchaInput)) {
    return { type: 'captcha-text', signals: { urlLooksCaptcha, hasCaptchaForm, hasCaptchaInput, hasCaptchaImg } };
  }

  if (is503) return { type: 'error', errorType: '503', signals: { is503 } };
  if (is504) return { type: 'error', errorType: '504', signals: { is504 } };

  return { type: 'normal', signals: { fallbackNormal: true } };
}

async function getTitle(page) {
  const title =
    (await page.textContent('#productTitle').catch(() => null)) ||
    (await page.textContent('#title').catch(() => null)) ||
    (await page.evaluate(() => {
      const el = document.querySelector('meta[property="og:title"]');
      return el ? el.getAttribute('content') : null;
    }).catch(() => null)) ||
    (await page.title().catch(() => null));
  return (title || '').trim();
}

// --- product scraping (brand, itemForm, price, mainImageUrl) ---
async function scrapeProductData(page) {
  return await page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || '').trim() : '';
    };

    // Brand: tr.po-brand > 2nd td, with fallbacks
    const brand = (() => {
      const tr = document.querySelector('tr.a-spacing-small.po-brand');
      if (tr) {
        const tds = tr.querySelectorAll('td');
        if (tds[1]) return (tds[1].textContent || '').trim();
      }
      const byline = document.querySelector('#bylineInfo');
      if (byline) return (byline.textContent || '').trim();
      const th = Array.from(document.querySelectorAll('th')).find(
        (el) => (el.textContent || '').trim().toLowerCase() === 'brand'
      );
      if (th && th.nextElementSibling) return (th.nextElementSibling.textContent || '').trim();
      return '';
    })();

    // Item Form: tr.po-item_form > 2nd td, with fallbacks
    const itemForm = (() => {
      const tr = document.querySelector('tr.a-spacing-small.po-item_form');
      if (tr) {
        const tds = tr.querySelectorAll('td');
        if (tds[1]) return (tds[1].textContent || '').trim();
      }
      const th = Array.from(document.querySelectorAll('th')).find(
        (el) => (el.textContent || '').trim().toLowerCase() === 'item form'
      );
      if (th && th.nextElementSibling) return (th.nextElementSibling.textContent || '').trim();
      const li = Array.from(document.querySelectorAll('li')).find((el) =>
        (el.textContent || '').toLowerCase().includes('item form')
      );
      if (li) {
        const parts = (li.textContent || '').split(':');
        if (parts.length > 1) return parts.slice(1).join(':').trim();
      }
      return '';
    })();

    // Price: first instance
    let price = '';
    try {
      const candidates = Array.from(document.querySelectorAll('.a-price .a-offscreen'))
        .map(el => (el.textContent || '').trim())
        .filter(t => /^\$?\d/.test(t));
      if (candidates.length) {
        price = candidates[0]; // ✅ first detected price
      }
    } catch {}

    if (!price) {
      price =
        text('#priceblock_ourprice') ||
        text('#priceblock_dealprice') ||
        text('#price_inside_buybox') ||
        '';
    }
    price = (price || '').trim();

    // Main image URL (prefer high-res)
    const mainImageUrl = (() => {
      const landing = document.querySelector('#landingImage');
      if (landing) {
        return landing.getAttribute('data-old-hires') ||
               landing.getAttribute('src') || '';
      }
      const imgTag = document.querySelector('#imgTagWrapperId img');
      if (imgTag) {
        return imgTag.getAttribute('data-old-hires') ||
               imgTag.getAttribute('src') || '';
      }
      const gallery = document.querySelector('#main-image-container img, .image.item.itemNo0 img, #main-image-container .image.item.itemNo0');
      if (gallery) {
        return gallery.getAttribute('data-old-hires') ||
               gallery.getAttribute('src') || '';
      }
      const candidates = Array.from(document.querySelectorAll('img'))
        .map(el => el.getAttribute('src') || '')
        .filter(src => src && !/sprite|transparent|blank/i.test(src));
      return candidates[0] || '';
    })();

    return {
      brand: (brand || '').replace(/\s+/g, ' ').trim(),
      itemForm: (itemForm || '').replace(/\s+/g, ' ').trim(),
      price: (price || '').replace(/\s+/g, ' ').trim(),
      mainImageUrl: (mainImageUrl || '').trim(),
    };
  });
}

async function screenshotCaptchaElementBase64(page) {
  const el =
    (await page.$('form[action*="validateCaptcha"] img')) ||
    (await page.$('img[src*="captcha"]')) ||
    (await page.$('form[action*="validateCaptcha"]'));

  if (!el) return { ok: false, reason: 'no-captcha-element' };

  for (const q of [60, 40, 25]) {
    try {
      const buf = await el.screenshot({ type: 'jpeg', quality: q });
      if (buf.length <= MAX_2CAPTCHA_BYTES) {
        return { ok: true, base64: buf.toString('base64'), bytes: buf.length, quality: q };
      }
      if (q === 25) {
        return { ok: false, reason: 'too-big', bytes: buf.length, lastQuality: q };
      }
    } catch (e) {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
        if (buf.length <= MAX_2CAPTCHA_BYTES) {
          return { ok: true, base64: buf.toString('base64'), bytes: buf.length, quality: 60, fallback: 'page' };
        }
        return { ok: false, reason: 'too-big-fallback', bytes: buf.length };
      } catch (e2) {
        return { ok: false, reason: 'screenshot-failed', error: e2.message };
      }
    }
  }
  return { ok: false, reason: 'unknown' };
}

// ---------- endpoints ----------
app.get('/', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send('✅ Amazon scraper with minimal stealth + 2Captcha is up.');
});
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/scrape', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: 'Missing url parameter' });

  const width = Math.max(320, Math.min(parseInt(req.query.w || '1280', 10) || 1280, 3000));
  const height = Math.max(400, Math.min(parseInt(req.query.h || '800', 10) || 800, 4000));

  const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.set('x-trace-id', traceId);

  let browser;
  try {
    const { browser: br, page } = await minimalContext(chromium, width, height);
    browser = br;

    const navResp = await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' });
    const httpStatus = navResp?.status?.() ?? null;

    // Consent
    try {
      const consent = await page.$('#sp-cc-accept, input[name="accept"]');
      if (consent && await consent.isVisible()) {
        await consent.click({ delay: 40 });
        await page.waitForTimeout(250);
      }
    } catch {}

    await page.waitForTimeout(400 + Math.floor(Math.random() * 400));

    // Detect state
    let detected = await detectCase(page);

    // Continue-shopping → click and re-check
    if (detected.type === 'continue-shopping') {
      await tryClickContinue(page);
      await page.waitForTimeout(300);
      detected = await detectCase(page);
    }

    // Error?
    if (detected.type === 'error' || httpStatus === 503 || httpStatus === 504) {
      const buf = await page.screenshot({ type: 'png' });
      await browser.close();
      return res.json({
        ok: false,
        _traceId: traceId,
        url,
        httpStatus,
        case: 'error',
        errorType: detected.errorType || (httpStatus ? String(httpStatus) : 'unknown'),
        detectorSignals: detected.signals || {},
        base64: buf.toString('base64'),
      });
    }

    // Captcha?
    if (detected.type.startsWith('captcha')) {
      const crop = await screenshotCaptchaElementBase64(page);
      if (!crop.ok) {
        const viewportShot = await page.screenshot({ type: 'png' });
        await browser.close();
        return res.json({
          ok: false,
          _traceId: traceId,
          url,
          case: detected.type,
          solverOk: false,
          solverStage: 'prepare',
          solverResponse: { reason: crop.reason, bytes: crop.bytes, quality: crop.lastQuality, note: 'captcha crop too large or missing' },
          detectorSignals: detected.signals || {},
          base64: viewportShot.toString('base64'),
        });
      }

      const solverResult = await solveTextCaptcha(crop.base64);
      const viewportShot = await page.screenshot({ type: 'png' });
      await browser.close();

      return res.json({
        ok: !!solverResult.ok,
        _traceId: traceId,
        url,
        case: detected.type, // "captcha-text"
        solverOk: solverResult.ok,
        solverStage: solverResult.stage || 'done',
        solverResponse: solverResult.response || null,
        solution: solverResult.ok ? { text: solverResult.text, captchaId: solverResult.captchaId } : null,
        detectorSignals: detected.signals || {},
        captchaImageBytes: crop.bytes,
        captchaImageQuality: crop.quality,
        base64: viewportShot.toString('base64'),
      });
    }

    // Normal page — get title + brand + itemForm + price + mainImageUrl
    const [title, pdata] = await Promise.all([
      getTitle(page),
      scrapeProductData(page),
    ]);
    const buf = await page.screenshot({ type: 'png' });

    await browser.close();
    return res.json({
      ok: true,
      _traceId: traceId,
      url,
      case: 'normal',
      title,
      brand: pdata.brand || '',
      itemForm: pdata.itemForm || '',
      price: pdata.price || '',
      mainImageUrl: pdata.mainImageUrl || '',
      detectorSignals: detected.signals || {},
      base64: buf.toString('base64'),
    });
  } catch (err) {
    try { await browser?.close(); } catch {}
    return res.status(500).json({
      ok: false,
      _traceId: traceId,
      url,
      case: 'error',
      errorType: 'exception',
      error: err.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Scraper + 2Captcha API running on port ${PORT}`);
});
