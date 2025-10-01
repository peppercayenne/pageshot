// index.js
// Express + Playwright + Gemini OCR (hardened)
// Scrapes Amazon product info via DOM + Gemini OCR on screenshot
// Defensive against racy "Continue/Keep shopping" flows, tab closures, and slow navs.
//
// GET /scrape?url=...

import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 8080;

// --- CORS (Airtable right-panel scripting allowed) ---
app.use(
  cors({
    origin: [/^https:\/\/airtable\.com$/, /^https:\/\/.*\.airtableblocks\.com$/],
    methods: ["GET"],
  })
);

// --- Gemini client ---
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in environment");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Keep this aligned with your current working model
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

function ensureAlive(page, msg = "Page is closed") {
  if (!page || page.isClosed()) throw new Error(msg);
}
function isClosedErr(err) {
  const msg = (err && err.message) || String(err || "");
  return /Target page, context or browser has been closed/i.test(msg);
}

// --- Playwright context (minimal but hardened) ---
async function minimalContext(width, height) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
    ],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    locale: "en-US",
  });

  const page = await context.newPage();

  // De-automation fingerprints
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // A bit more "realism"
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  });

  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
  });

  return { browser, context, page };
}

// --- Soft block detection ---
function isRobotCheckUrl(url) {
  if (!url) return false;
  return (
    url.includes("/errors/validateCaptcha") ||
    url.includes("/captcha") ||
    url.includes("/sorry")
  );
}
async function looksBlocked(page) {
  try {
    const url = page.url();
    if (isRobotCheckUrl(url)) return true;
    const title = (await page.title().catch(() => "")) || "";
    if (/robot check|captcha/i.test(title)) return true;
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    if (/enter the characters|type the characters|sorry|robot check|captcha/i.test(bodyText)) {
      return true;
    }
  } catch {}
  return false;
}

// --- Nav with retry + block check ---
async function safeGoto(page, url, { retries = 2, timeout = 70000 } = {}) {
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try {
      await sleep(jitter(250, 500));
      await page.goto(url, { timeout, waitUntil: "commit" });
      // allow render/redirects to settle
      await sleep(jitter(800, 800));
      if (await looksBlocked(page)) throw new Error("Blocked by Amazon CAPTCHA/anti-bot");
      return;
    } catch (err) {
      lastErr = err;
      if (page.isClosed()) throw lastErr;
      if (attempt < retries) await sleep(jitter(1200, 1500));
      attempt++;
    }
  }
  throw lastErr || new Error("Navigation failed");
}

// --- Adopt most plausible active page ---
async function adoptActivePageOrThrow(currentPage, context) {
  if (currentPage && !currentPage.isClosed()) return currentPage;
  const pages = context.pages().filter((p) => !p.isClosed());
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i];
    if (p.url() !== "about:blank") {
      try { await p.bringToFront(); } catch {}
      return p;
    }
  }
  if (pages[0]) return pages[0];
  throw new Error("All pages are closed");
}

// --- Close "Added to Cart" side sheet if visible (non-fatal) ---
async function closeAttachSideSheetIfVisible(page) {
  try {
    const closed = await page.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const candidates = [
        "#attach-close_sideSheet-link",
        ".a-button-close",
        ".a-popover-header .a-icon-close",
        'button[aria-label="Close"]',
        'button[aria-label="Close dialog"]',
      ];
      for (const sel of candidates) {
        const el = q(sel);
        if (el && getComputedStyle(el).display !== "none" && !el.disabled) {
          el.click();
          return true;
        }
      }
      return false;
    });
    return !!closed;
  } catch { return false; }
}

// --- Robust click with retries + gentle mouse move ---
async function clickLocatorWithRetry(page, locator, {
  attempts = 3,
  visibleTimeout = 1500,
  betweenMs = [180, 420], // jitter
} = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const el = locator.first();
      const ok = await el.isVisible({ timeout: visibleTimeout }).catch(() => false);
      if (!ok) throw new Error("continue-shopping candidate not visible");
      try { await el.scrollIntoViewIfNeeded(); } catch {}
      try {
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          await page.mouse.move(cx + 0.1, cy + 0.1, { steps: 12 });
        }
      } catch {}
      await el.click({ timeout: 2500 });
      return true;
    } catch (e) {
      if (i < attempts - 1) {
        const wait = betweenMs[0] + Math.floor(Math.random() * (betweenMs[1] - betweenMs[0]));
        await page.waitForTimeout(wait);
        continue;
      }
      return false;
    }
  }
  return false;
}

// --- Detect & click "Continue/Keep shopping" robustly ---
async function clickContinueShoppingIfPresent(page) {
  // 0) Close side sheet if it exists (common on add-to-cart)
  if (await closeAttachSideSheetIfVisible(page)) {
    return true;
  }

  const KNOWN_SELECTORS = [
    '#hlb-continue-shopping-announce',
    'a#hlb-continue-shopping-announce',
    '#continue-shopping',
    'button#continue-shopping',
    'a[href*="continueShopping"]',
    'button[name*="continueShopping"]',
    'input[type="submit"][value*="Continue shopping" i]',
    'input[type="submit"][value*="Keep shopping" i]',
    'a:has-text("Keep shopping")',
    'button:has-text("Keep shopping")',
    '#attach-close_sideSheet-link',
  ];

  // 1) Known selectors (with retries)
  for (const sel of KNOWN_SELECTORS) {
    try {
      const ok = await clickLocatorWithRetry(page, page.locator(sel), {
        attempts: 3,
        visibleTimeout: 1500,
      });
      if (ok) return true;
    } catch {}
  }

  // 2) Text-only locators
  try {
    const textLoc = page.locator(
      'button:has-text("Continue shopping"), a:has-text("Continue shopping"), ' +
      '[role="button"]:has-text("Continue shopping"), ' +
      'button:has-text("Keep shopping"), a:has-text("Keep shopping")'
    );
    const ok = await clickLocatorWithRetry(page, textLoc, { attempts: 3, visibleTimeout: 1500 });
    if (ok) return true;
  } catch {}

  // 3) Last-resort DOM sweep, retried (guard for racy closes)
  for (let i = 0; i < 3; i++) {
    try {
      const clicked = await page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll('button, a, input[type="submit"], div[role="button"]')
        );
        const target = nodes.find((n) => {
          const txt = ((n.innerText || n.value || "") + "").toLowerCase();
          return txt.includes("continue shopping") || txt.includes("keep shopping");
        });
        if (target) {
          target.scrollIntoView?.({ block: "center", inline: "center" });
          target.click();
          return true;
        }
        return false;
      });
      if (clicked) return true;
    } catch {
      // If evaluate throws because the page navigated/closed, treat as likely-click
      return true;
    }
    await page.waitForTimeout(220 + Math.floor(Math.random() * 220));
  }

  return false;
}

// --- Wait for any signal of change after click ---
async function waitAny(page, context, { pageTimeout = 9000, navTimeout = 20000 } = {}) {
  return await Promise.race([
    context.waitForEvent("page", { timeout: pageTimeout }).catch(() => null),
    page?.waitForNavigation({ timeout: navTimeout, waitUntil: "commit" }).catch(() => null),
    page?.waitForLoadState("domcontentloaded", { timeout: navTimeout }).catch(() => null),
  ]);
}

// --- Adopt active or create a fresh one and (optionally) reload ---
async function ensureFreshOrAdopt(page, context, fallbackUrl) {
  // scan a few times to catch late-opening tabs
  for (let i = 0; i < 4; i++) {
    const pages = context.pages().filter((p) => !p.isClosed());
    for (let j = pages.length - 1; j >= 0; j--) {
      const p = pages[j];
      const u = p.url();
      if (u && u !== "about:blank" && !p.isClosed()) {
        try { await p.bringToFront(); } catch {}
        return p;
      }
    }
    if (pages[0]) return pages[0];
    await sleep(200 + Math.floor(Math.random() * 160));
  }
  // nothing → create new
  const fresh = await context.newPage();
  try { await fresh.bringToFront(); } catch {}
  if (fallbackUrl) await safeGoto(fresh, fallbackUrl, { retries: 1, timeout: 70000 });
  return fresh;
}

// --- Handle continue/keep shopping clicks robustly ---
async function handleContinueShopping(page, context, fallbackUrl) {
  try {
    const beforeClosed = !page || page.isClosed();
    const beforeUrl = beforeClosed ? "" : page.url();

    const clicked = await clickContinueShoppingIfPresent(page);

    // Edge-case: evaluate clicked but returned false; detect change anyway
    if (!clicked) {
      if (!page || page.isClosed()) {
        return await ensureFreshOrAdopt(page, context, fallbackUrl);
      }
      const afterUrl = page.url();
      if (afterUrl && afterUrl !== beforeUrl) {
        await waitAny(page, context);
        const adopted = await ensureFreshOrAdopt(page, context, null);
        if (adopted && !adopted.isClosed()) return adopted;
        return await ensureFreshOrAdopt(page, context, fallbackUrl);
      }
      // nothing happened, keep current
      return page;
    }

    // Normal path: we know a click attempt happened
    await waitAny(page, context);
    let adopted = await ensureFreshOrAdopt(page, context, null);
    if (adopted && !adopted.isClosed()) return adopted;

    // If still no luck and page alive, try one more click & wait
    if (page && !page.isClosed()) {
      const clickedAgain = await clickContinueShoppingIfPresent(page);
      if (clickedAgain) {
        await waitAny(page, context);
        adopted = await ensureFreshOrAdopt(page, context, null);
        if (adopted && !adopted.isClosed()) return adopted;
      }
    }

    // Final fallback: fresh page
    return await ensureFreshOrAdopt(page, context, fallbackUrl);
  } catch {
    const adopted = await ensureFreshOrAdopt(page, context, null);
    if (adopted && !adopted.isClosed()) return adopted;
    return await ensureFreshOrAdopt(page, context, fallbackUrl);
  }
}

// --- Safer screenshot with retry ---
async function safeScreenshot(page, opts = { type: "png" }, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    ensureAlive(page, "Page closed before screenshot");
    try {
      return await page.screenshot(opts);
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) || String(err);
      if (isClosedErr(err)) throw new Error("Screenshot failed: " + msg);
      if (i < retries) { await sleep(jitter(250, 500)); continue; }
      throw new Error("Screenshot failed: " + msg);
    }
  }
  throw lastErr || new Error("Screenshot failed");
}

// --- Product page heuristic ---
async function isProductPage(page) {
  try {
    return await page.evaluate(() => {
      const url = location.href;
      const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
      const urlFlag =
        /\/dp\/[A-Z0-9]{8,}|\b\/gp\/product\/[A-Z0-9]{8,}/i.test(url) ||
        /\/dp\/[A-Z0-9]{8,}|\b\/gp\/product\/[A-Z0-9]{8,}/i.test(canonical);

      const hasTitle =
        !!document.querySelector("#productTitle") ||
        !!document.querySelector("#titleSection #title");
      const hasByline = !!document.querySelector("#bylineInfo");
      const hasBuyCtas =
        !!document.querySelector("#add-to-cart-button, input#add-to-cart-button") ||
        !!document.querySelector("#buy-now-button, input#buy-now-button");

      const layoutHints = !!document.querySelector("#dp, #dp-container, #ppd, #centerCol, #leftCol");

      return (urlFlag && hasTitle && layoutHints) || ((hasTitle || hasByline) && hasBuyCtas);
    });
  } catch { return false; }
}

// --- Extract links/buttons if we aren't on a product page ---
async function extractLinksAndButtons(page, limits = { maxLinks: 300, maxButtons: 300 }) {
  return await page.evaluate((limits) => {
    const toAbs = (u) => { try { return u ? new URL(u, location.href).href : ""; } catch { return u || ""; } };
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    const linkNodes = Array.from(document.querySelectorAll("a"));
    const btnNodes = Array.from(
      document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]')
    );

    const links = linkNodes.slice(0, limits.maxLinks).map((el) => ({
      tag: "a",
      text: clean(el.innerText || el.textContent || ""),
      href: toAbs(el.getAttribute("href")),
      id: el.id || "",
      classes: clean(el.className || ""),
      rel: el.getAttribute("rel") || "",
      target: el.getAttribute("target") || "",
      role: el.getAttribute("role") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      onclick: el.getAttribute("onclick") || "",
    }));

    const buttons = btnNodes.slice(0, limits.maxButtons).map((el) => {
      const tag = (el.tagName || "").toLowerCase();
      return {
        tag,
        text: clean(el.innerText || el.value || el.textContent || ""),
        id: el.id || "",
        classes: clean(el.className || ""),
        name: el.getAttribute("name") || "",
        type: el.getAttribute("type") || "",
        role: el.getAttribute("role") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        onclick: el.getAttribute("onclick") || "",
        href:
          tag === "a"
            ? toAbs(el.getAttribute("href"))
            : el.getAttribute("href")
            ? toAbs(el.getAttribute("href"))
            : "",
      };
    });

    // de-dupe
    const seenL = new Set(), dedupLinks = [];
    for (const l of links) {
      const k = `${l.href}|${l.text}`;
      if (l.href && !seenL.has(k)) { seenL.add(k); dedupLinks.push(l); }
    }
    const seenB = new Set(), dedupButtons = [];
    for (const b of buttons) {
      const k = `${b.text}|${b.id}`;
      if (!seenB.has(k)) { seenB.add(k); dedupButtons.push(b); }
    }

    return { links: dedupLinks, buttons: dedupButtons, counts: { links: links.length, buttons: buttons.length } };
  }, limits);
}

// --- Product scraping (Playwright side) ---
async function scrapeProductData(page) {
  const title =
    (await page.textContent("#productTitle").catch(() => null)) ||
    (await page.textContent("#title").catch(() => null));

  return await page.evaluate((title) => {
    const itemForm = (() => {
      const row =
        document.querySelector("tr.po-item_form") ||
        document.querySelector('tr[class*="po-item_form"]');
      if (row) {
        const tds = row.querySelectorAll("td");
        if (tds.length >= 2) {
          const text = (tds[1].innerText || tds[1].textContent || "").replace(/\s+/g, " ").trim();
          if (text) return text;
        }
      }
      const altRow = Array.from(document.querySelectorAll("tr")).find((tr) => {
        const firstTd = tr.querySelector("td");
        if (!firstTd) return false;
        const label = (firstTd.innerText || firstTd.textContent || "").toLowerCase();
        return /item\s*form/.test(label);
      });
      if (altRow) {
        const tds = altRow.querySelectorAll("td");
        if (tds.length >= 2) {
          const text = (tds[1].innerText || tds[1].textContent || "").replace(/\s+/g, " ").trim();
          if (text) return text;
        }
      }
      const li = Array.from(document.querySelectorAll("#detailBullets_feature_div li, li"))
        .find((el) => /item\s*form/i.test(el.innerText || el.textContent || ""));
      if (li) {
        const raw = (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim();
        const m = raw.match(/item\s*form\s*[:\-]?\s*(.+)$/i);
        if (m && m[1]) return m[1].trim();
      }
      return "";
    })();

    const getPriceWithCurrency = () => {
      const priceEl =
        document.querySelector(".a-price .a-offscreen") ||
        document.querySelector("#priceblock_ourprice, #priceblock_dealprice, #priceblock_saleprice");
      let text = (priceEl?.textContent || "").trim();
      const hasCurrency = /[\p{Sc}]|\b[A-Z]{3}\b/u.test(text);
      if (text && !hasCurrency) {
        const sym = document.querySelector(".a-price .a-price-symbol")?.textContent?.trim() || "";
        if (sym) text = sym + text;
        else {
          const iso = document.querySelector('meta[property="og:price:currency"]')?.getAttribute("content") || "";
          if (iso) text = iso + " " + text;
        }
      }
      return text || "";
    };
    const price = getPriceWithCurrency();

    const featuredBullets = (() => {
      const items = Array.from(document.querySelectorAll("#feature-bullets ul li"))
        .map((li) => (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((text) => `• ${text} `);
      return items.length ? items.join("") : "";
    })();

    const productDescription = (() => {
      const el = document.querySelector("#productDescription");
      if (!el) return "";
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    })();

    const mainImageUrl = (() => {
      const imgTag = document.querySelector("#landingImage") || document.querySelector("#imgTagWrapperId img");
      if (imgTag) return imgTag.getAttribute("src") || "";
      return "";
    })();

    const normalizeImageUrl = (url) => {
      if (!url) return "";
      return url.replace(/\._[A-Z0-9_,]+\_\.jpg/i, ".jpg");
    };
    const normalizedMain = normalizeImageUrl((mainImageUrl || "").trim());

    let additionalImageUrls = Array.from(document.querySelectorAll("#altImages img, .imageThumb img"))
      .map((img) => img.getAttribute("src") || "")
      .map((src) => (src || "").trim())
      .filter(Boolean);

    const landing = document.querySelector("#landingImage") || document.querySelector("#imgTagWrapperId img");
    const fromLandingAttrs = [];
    if (landing) {
      const oldHires = landing.getAttribute("data-old-hires");
      if (oldHires) fromLandingAttrs.push(oldHires);
      const dyn = landing.getAttribute("data-a-dynamic-image");
      if (dyn) {
        try {
          const clean = dyn.replace(/&quot;/g, '"');
          const obj = JSON.parse(clean);
          for (const k of Object.keys(obj || {})) fromLandingAttrs.push(k);
        } catch {
          try {
            const clean2 = dyn
              .replace(/&quot;/g, '"')
              .replace(/([{,]\s*)'([^']+?)'\s*:/g, '$1"$2":')
              .replace(/:\s*'([^']+?)'(\s*[},])/g, ':"$1"$2');
            const obj2 = JSON.parse(clean2);
            for (const k of Object.keys(obj2 || {})) fromLandingAttrs.push(k);
          } catch {}
        }
      }
    }

    const hiResMatches = Array.from(
      document.documentElement.innerHTML.matchAll(
        /https:\/\/[^"\s]+?\._AC_SL\d+_\.jpg(?:\?[^"\s]*)?/gi
      )
    ).map((m) => m[0]);

    additionalImageUrls = [
      ...additionalImageUrls,
      ...fromLandingAttrs.map((u) => (u || "").trim()).filter(Boolean),
      ...hiResMatches,
    ];

    additionalImageUrls = additionalImageUrls.filter((src) => {
      if (!src) return false;
      const lower = src.toLowerCase();
      return !(
        lower.includes("sprite") ||
        lower.includes("360_icon") ||
        lower.includes("play-icon") ||
        lower.includes("overlay") ||
        lower.includes("fmjpg") ||
        lower.includes("fmpng")
      );
    });

    const AC_ANY = /\._AC_SL\d+_\.jpg(?:\?.*)?$/i;
    additionalImageUrls = additionalImageUrls
      .filter((url) => url && url !== normalizedMain)
      .filter((url) => AC_ANY.test(url));

    additionalImageUrls = [...new Set(additionalImageUrls)];

    return {
      title: (title || "").trim(),
      itemForm: (itemForm || "").trim(),
      price: (price || "").trim(),
      featuredBullets: (featuredBullets || "").trim(),
      productDescription: (productDescription || "").trim(),
      mainImageUrl: normalizedMain || "",
      additionalImageUrls,
    };
  }, title);
}

// --- Gemini OCR (Brand + Price) ---
function includesCurrency(s = "") {
  return /[\p{Sc}]|\b[A-Z]{3}\b/u.test(s);
}
function currencyToken(s = "") {
  const m = s.match(/([\p{Sc}]|\b[A-Z]{3}\b)/u);
  return m ? m[1] : "";
}
async function geminiExtract(base64Image) {
  const prompt = `
You are given a screenshot of an Amazon product page.
Extract JSON with exactly these keys:
- brand: string (brand or manufacturer name)
- price: string (include currency symbol or ISO code, e.g., "$12.99" or "USD 12.99")
Rules:
- Return ONLY valid minified JSON: {"brand":"...","price":"..."}
- If a field is unknown or not visible, use "Unspecified".`;

  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { mimeType: "image/png", data: base64Image } },
  ]);

  let text = result.response.text().trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  try {
    const parsed = JSON.parse(text);
    return {
      brand: typeof parsed.brand === "string" ? parsed.brand.trim() : "Unspecified",
      price: typeof parsed.price === "string" ? parsed.price.trim() : "Unspecified",
    };
  } catch {
    return { brand: "Unspecified", price: "Unspecified" };
  }
}

// --- Normalize Gemini price (fix superscripts, missing currency, etc.) ---
function normalizeGeminiPrice(raw = "", domPrice = "") {
  let s = (raw || "").trim();
  if (!s) return "Unspecified";

  s = s.replace(/[\u00A0\u2009\u202F]/g, " ");

  const hadSuper = /[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(s);
  const map = {
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
    "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
    "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
  };
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/g, (ch) => map[ch] || ch);

  if (!/\d\.\d{2,}/.test(s) && /(\d+),(\d{2})\b/.test(s)) {
    s = s.replace(/(\d+),(\d{2})\b/, "$1.$2");
  }
  if (!/\d\.\d{2,}/.test(s) && /(\d+)\s+(\d{2})\b/.test(s)) {
    s = s.replace(/(\d+)\s+(\d{2})\b/, "$1.$2");
  }

  if (hadSuper && !/\d\.\d{2,}/.test(s)) {
    const digits = (s.match(/\d+/g) || []).join("");
    if (digits.length >= 3) {
      const num = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
      const cur = currencyToken(s) || currencyToken(domPrice);
      s = cur ? `${cur} ${num}` : num;
    }
  }

  if (!includesCurrency(s) && includesCurrency(domPrice)) {
    const cur = currencyToken(domPrice);
    if (cur) s = `${cur} ${s}`;
  }

  s = s.replace(/\s+/g, " ").trim();
  return s || "Unspecified";
}

// --- Utilities ---
function extractASINFromUrl(u = "") {
  try {
    const url = new URL(u);
    const path = url.pathname;
    const m1 = path.match(/\/dp\/([A-Z0-9]{8,10})/i);
    const m2 = path.match(/\/gp\/product\/([A-Z0-9]{8,10})/i);
    return (m1?.[1] || m2?.[1] || "").toUpperCase() || "";
  } catch {
    const m1 = u.match(/\/dp\/([A-Z0-9]{8,10})/i);
    const m2 = u.match(/\/gp\/product\/([A-Z0-9]{8,10})/i);
    return (m1?.[1] || m2?.[1] || "").toUpperCase() || "";
  }
}

// --- endpoints ---
app.get("/", (req, res) => {
  res.send("✅ Amazon scraper with Playwright + Gemini OCR is up.");
});

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url param" });

  const width = 1280, height = 800;

  let browser, context, page;
  try {
    const ctx = await minimalContext(width, height);
    browser = ctx.browser;
    context = ctx.context;
    page = ctx.page;

    // Nav with retries + block detection
    await safeGoto(page, url, { retries: 2, timeout: 70000 });
    ensureAlive(page, "Page unexpectedly closed after navigation");

    // Handle Amazon "Continue/Keep shopping" and side sheets robustly
    page = await handleContinueShopping(page, context, url);

    // If handler returned a closed/empty page, resurrect once here instead of erroring
    if (!page || page.isClosed()) {
      const fresh = await context.newPage();
      try { await fresh.bringToFront(); } catch {}
      await safeGoto(fresh, url, { retries: 1, timeout: 70000 });
      page = fresh;
    }
    ensureAlive(page, "Page closed after continue-shopping handling (reloaded)");

    // Detect product page
    let productLike;
    try {
      productLike = await isProductPage(page);
    } catch (e) {
      if (isClosedErr(e)) {
        page = await adoptActivePageOrThrow(page, context);
        await sleep(200);
        productLike = await isProductPage(page);
      } else { throw e; }
    }

    // Non-product page: screenshot + links/buttons
    if (!productLike) {
      let bufNP;
      try {
        bufNP = await safeScreenshot(page, { type: "png" }, 1);
      } catch (e) {
        if (isClosedErr(e)) {
          page = await adoptActivePageOrThrow(page, context);
          bufNP = await safeScreenshot(page, { type: "png" }, 1);
        } else { throw e; }
      }
      const base64NP = bufNP.toString("base64");
      const meta = {
        currentUrl: page.url(),
        title: (await page.title().catch(() => "")) || "",
      };
      const { links, buttons, counts } = await extractLinksAndButtons(page).catch(() => ({
        links: [],
        buttons: [],
        counts: { links: 0, buttons: 0 },
      }));
      return res.json({
        ok: true,
        url: meta.currentUrl,
        pageType: "nonProduct",
        screenshot: base64NP,
        meta,
        links,
        buttons,
        counts,
      });
    }

    // Small settle for above-the-fold
    await sleep(jitter(300, 400));

    // Scrape Playwright-visible fields
    let scraped;
    try {
      scraped = await scrapeProductData(page);
    } catch (e) {
      if (isClosedErr(e)) {
        page = await adoptActivePageOrThrow(page, context);
        await sleep(200);
        scraped = await scrapeProductData(page);
      } else { throw e; }
    }

    ensureAlive(page, "Page closed before screenshot");

    // Screenshot for OCR
    let buf;
    try {
      buf = await safeScreenshot(page, { type: "png" }, 1);
    } catch (e) {
      if (isClosedErr(e)) {
        page = await adoptActivePageOrThrow(page, context);
        buf = await safeScreenshot(page, { type: "png" }, 1);
      } else { throw e; }
    }
    const base64 = buf.toString("base64");

    // Gemini OCR
    const gemini = await geminiExtract(base64);
    const priceGemini = normalizeGeminiPrice(gemini.price, scraped.price);

    const resolvedUrl = page.url() || url;
    const asin = extractASINFromUrl(resolvedUrl) || extractASINFromUrl(url);

    // Final payload
    res.json({
      ok: true,
      url: resolvedUrl,
      pageType: "product",
      ASIN: asin || "Unspecified",
      title: scraped.title || "Unspecified",
      brand: gemini.brand || "Unspecified",
      itemForm: scraped.itemForm || "Unspecified",
      price: scraped.price || "Unspecified",
      priceGemini: priceGemini || "Unspecified",
      featuredBullets: scraped.featuredBullets || "Unspecified",
      productDescription: scraped.productDescription || "Unspecified",
      mainImageUrl: scraped.mainImageUrl || "Unspecified",
      additionalImageUrls: scraped.additionalImageUrls || [],
      screenshot: base64,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    // Close all pages to avoid leaks if a popup was opened
    try {
      for (const p of context?.pages?.() || []) {
        try { if (!p.isClosed()) await p.close({ runBeforeUnload: false }); } catch {}
      }
    } catch {}
    try { await browser?.close(); } catch {}
  }
});

// --- Start server ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Running on port ${PORT}`);
});
