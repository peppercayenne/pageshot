// index.js
// Express + Playwright + Gemini OCR
// Scrapes Amazon product info via DOM + Gemini OCR on screenshot
//
// GET /scrape?url=...

import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 8080;

// Allow browser requests from Airtable (right panel scripting)
app.use(
  cors({
    origin: [/^https:\/\/airtable\.com$/, /^https:\/\/.*\.airtableblocks\.com$/],
    methods: ["GET"],
  })
);

// Gemini client
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in environment");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

/* ---------------------------- Playwright context --------------------------- */
async function minimalContext(width, height) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
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

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

  return { browser, context, page };
}

/* --------------------------------- Helpers -------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

function ensureAlive(page, msg = "Page is closed") {
  if (!page || page.isClosed()) throw new Error(msg);
}
function isClosedErr(err) {
  const msg = (err && err.message) || String(err || "");
  return /Target page, context or browser has been closed/i.test(msg);
}
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
const isDpUrl = (u = "") => /\/dp\/[A-Z0-9]{8,10}/i.test(u);
const buildDpUrl = (asin) => (asin ? `https://www.amazon.com/dp/${asin}` : "");

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
    if (/robot check/i.test(title) || /captcha/i.test(title)) return true;
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    if (/enter the characters|type the characters|sorry/i.test(bodyText)) return true;
  } catch {}
  return false;
}
function isLikelyDetourUrl(u = "") {
  return (
    /\/hz\/mobile\/mission/i.test(u) ||
    /\/ap\/signin/i.test(u) ||
    /\/gp\/help/i.test(u) ||
    /\/gp\/navigation/i.test(u) ||
    /\/customer-preferences/i.test(u) ||
    /\/gp\/yourstore/i.test(u) ||
    /\/gp\/history/i.test(u)
  );
}

// NEW helpers for frame-aware overlay handling
function likelyAttachFrame(f) {
  const name = (f.name() || "");
  const url = (f.url() || "");
  return /attach|sidesheet|hlb|add-to-cart|upsell/i.test(name) || /attach|sidesheet|hlb|add-to-cart|upsell/i.test(url);
}
function getAttachFrames(page) {
  return page.frames().filter(likelyAttachFrame);
}
async function waitForOverlayToSettleOrTitle(page, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const overlayGone = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        return !(
          q("#attach-close_sideSheet-link") ||
          q("#attachAccessoryView") ||
          q("#attach-desktop-sideSheet") ||
          q('iframe[name*="attach"], iframe#attachSideSheet, iframe#attach-sidesheet-frame')
        );
      }).catch(() => false);

      const titleBack = await hasProductTitle(page).catch(() => false);

      if (overlayGone || titleBack) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

/* ---------------------------- Navigation helpers -------------------------- */
async function safeGoto(page, url, { retries = 2, timeout = 60000 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      await sleep(jitter(250, 500));
      await page.goto(url, { timeout, waitUntil: "commit" });
      await sleep(jitter(700, 600));
      if (await looksBlocked(page)) throw new Error("Blocked by Amazon CAPTCHA/anti-bot");
      return;
    } catch (err) {
      lastErr = err;
      if (page.isClosed()) throw lastErr;
      if (attempt < retries) await sleep(jitter(1000, 1500));
      attempt++;
    }
  }
  throw lastErr || new Error("Navigation failed");
}

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
  } catch {
    return false;
  }
}

async function hasProductTitle(page) {
  try {
    return await page.evaluate(() => {
      return !!(document.querySelector("#productTitle") || document.querySelector("#title"));
    });
  } catch {
    return false;
  }
}

/* ---------------- Improved Continue Shopping logic (frame-aware) ---------- */
// Click “Continue/Keep shopping” if present — calls onClick() when we actually click.
async function clickContinueShoppingIfPresent(page, onClick) {
  // 1) explicit close in main frame
  if (await closeAttachSideSheetIfVisible(page)) {
    onClick?.();
    await waitForOverlayToSettleOrTitle(page, 5000);
    return true;
  }

  // candidates in main frame
  const pageCandidates = [
    page.getByRole('button', { name: /continue shopping|keep shopping/i }),
    page.getByRole('link',   { name: /continue shopping|keep shopping/i }),
    page.locator('#hlb-continue-shopping-announce'),
    page.locator('#continue-shopping'),
    page.locator('a#hlb-continue-shopping-announce'),
    page.locator('#attach-close_sideSheet-link'),
    page.locator('input[type="submit"]').filter({ hasText: /continue shopping|keep shopping/i }),
    page.locator('button, a, input[type="submit"], [role="button"]').filter({ hasText: /continue shopping|keep shopping/i }),
  ];

  // candidates in attach/HLB iframes
  const frameCandidates = [];
  for (const f of getAttachFrames(page)) {
    frameCandidates.push(
      f.getByRole('button', { name: /continue shopping|keep shopping/i }),
      f.getByRole('link',   { name: /continue shopping|keep shopping/i }),
      f.locator('#hlb-continue-shopping-announce'),
      f.locator('#attach-close_sideSheet-link'),
      f.locator('button, a, input[type="submit"], [role="button"]').filter({ hasText: /continue shopping|keep shopping/i }),
    );
  }

  const tryClick = async (loc) => {
    try {
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        try { await loc.scrollIntoViewIfNeeded({ timeout: 500 }); } catch {}
        await loc.click({ timeout: 1500 }).catch(() => {});
        onClick?.();
        await waitForOverlayToSettleOrTitle(page, 5000);
        return true;
      }
    } catch {}
    return false;
  };

  for (const loc of [...pageCandidates, ...frameCandidates]) {
    if (await tryClick(loc)) return true;
  }

  // Soft fallback: Esc can dismiss side-sheet
  try { await page.keyboard.press('Escape'); } catch {}
  if (await waitForOverlayToSettleOrTitle(page, 2500)) {
    onClick?.();
    return true;
  }

  return false;
}

// EXACT request: click literal "Continue/Keep shopping" up to maxTries; on each success, onClick()
async function trySimpleContinueShoppingFallback(page, maxTries = 3, onClick) {
  for (let i = 0; i < maxTries; i++) {
    let clicked = false;

    const t = page.getByText(/continue shopping|keep shopping/i).first();
    if (await t.isVisible({ timeout: 600 }).catch(() => false)) {
      await t.click({ timeout: 1500 }).catch(() => {});
      clicked = true;
      onClick?.();
    } else {
      for (const f of getAttachFrames(page)) {
        const ft = f.getByText(/continue shopping|keep shopping/i).first();
        if (await ft.isVisible({ timeout: 400 }).catch(() => false)) {
          await ft.click({ timeout: 1500 }).catch(() => {});
          clicked = true;
          onClick?.();
          break;
        }
      }
    }

    await Promise.race([
      page.waitForNavigation({ waitUntil: "commit", timeout: 3000 }).catch(() => null),
      page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => null),
      waitForOverlayToSettleOrTitle(page, 3000),
    ]);

    if (await hasProductTitle(page)) return true;

    if (!clicked) {
      try { await page.keyboard.press('Escape'); } catch {}
      await sleep(300);
    }
  }
  return false;
}

async function handleContinueShopping(page, context, fallbackUrl, onClick) {
  try {
    const clicked = await clickContinueShoppingIfPresent(page, onClick);
    if (!clicked) return page;

    const popupPromise  = context.waitForEvent("page", { timeout: 6000 }).catch(() => null);
    const navPromise    = page.waitForNavigation({ timeout: 10000, waitUntil: "commit" }).catch(() => null);
    const dclPromise    = page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => null);
    const settlePromise = waitForOverlayToSettleOrTitle(page, 5000);
    await Promise.race([popupPromise, navPromise, dclPromise, settlePromise]);

    const active = context.pages().find((p) => !p.isClosed() && p.url() !== "about:blank");
    if (active) {
      try { await active.bringToFront(); } catch {}
      return active;
    }

    const fresh = await context.newPage();
    try { await fresh.bringToFront(); } catch {}
    if (fallbackUrl) await safeGoto(fresh, fallbackUrl, { retries: 1, timeout: 60000 });
    return fresh;
  } catch {
    try {
      const adopted = await adoptActivePageOrThrow(page, context);
      return adopted;
    } catch {
      const fresh = await context.newPage();
      try { await fresh.bringToFront(); } catch {}
      if (fallbackUrl) await safeGoto(fresh, fallbackUrl, { retries: 1, timeout: 60000 });
      return fresh;
    }
  }
}

/* ------------------------------ Product scrape ---------------------------- */
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
      const li = Array.from(document.querySelectorAll("#detailBullets_feature_div li, li")).find((el) =>
        /item\s*form/i.test(el.innerText || el.textContent || "")
      );
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

    const normalizeImageUrl = (url) => (url ? url.replace(/\._[A-Z0-9_,]+\_\.jpg/i, ".jpg") : "");
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

    additionalImageUrls = [
      ...additionalImageUrls,
      ...fromLandingAttrs.map((u) => (u || "").trim()).filter(Boolean),
    ];

    const hiResMatches = Array.from(
      document.documentElement.innerHTML.matchAll(/https:\/\/[^"\s]+?\._AC_SL\d+_\.jpg(?:\?[^"\s]*)?/gi)
    ).map((m) => m[0]);

    additionalImageUrls = [...new Set([...additionalImageUrls, ...hiResMatches])];

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
      itemForm: itemForm.trim(),
      price: (price || "").trim(),
      featuredBullets: (featuredBullets || "").trim(),
      productDescription: (productDescription || "").trim(),
      mainImageUrl: normalizedMain || "",
      additionalImageUrls,
    };
  }, title);
}

/* ------------------------------- Gemini OCR ------------------------------- */
function includesCurrency(s = "") {
  return /[\p{Sc}]|\b[A-Z]{3}\b/u.test(s);
}
function currencyToken(s = "") {
  const m = s.match(/([\p{Sc}]|\b[A-Z]{3}\b)/u);
  return m ? m[1] : "";
}
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
  if (!/\d\.\d{2,}/.test(s) && /(\d+),(\d{2})\b/.test(s)) s = s.replace(/(\d+),(\d{2})\b/, "$1.$2");
  if (!/\d\.\d{2,}/.test(s) && /(\d+)\s+(\d{2})\b/.test(s)) s = s.replace(/(\d+)\s+(\d{2})\b/, "$1.$2");
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

/* -------------------------------- Endpoint -------------------------------- */
app.get("/", (req, res) => {
  res.send("✅ Amazon scraper with Playwright + Gemini OCR is up.");
});

app.get("/scrape", async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).json({ ok: false, error: "Missing url param" });

  const width = 1280, height = 800;
  const asin = extractASINFromUrl(inputUrl);
  const intendedDpUrl = buildDpUrl(asin);
  const returnUrl = intendedDpUrl || inputUrl; // we will report this in JSON

  let browser, context, page;
  // Stats
  let nonProductCount = 0;
  const nonProductUrls = [];
  let continueShoppingClicks = 0;

  try {
    const ctx = await minimalContext(width, height);
    browser = ctx.browser;
    context = ctx.context;
    page = ctx.page;

    // First nav: go to the given URL
    await safeGoto(page, inputUrl, { retries: 2, timeout: 60000 });
    ensureAlive(page, "Page unexpectedly closed after navigation");

    // If we get detoured and we know the intended /dp/ASIN, bounce back immediately (up to 3 tries)
    const bounceBackToDp = async () => {
      if (!intendedDpUrl) return;
      for (let i = 0; i < 3; i++) {
        const curUrl = page.url();
        if (isDpUrl(curUrl)) break;
        if (isLikelyDetourUrl(curUrl) || !isDpUrl(curUrl)) {
          nonProductCount++;
          nonProductUrls.push(curUrl);
          await safeGoto(page, intendedDpUrl, { retries: 1, timeout: 60000 });
          await handleContinueShopping(page, context, intendedDpUrl, () => continueShoppingClicks++);
          if (!(await hasProductTitle(page))) {
            await trySimpleContinueShoppingFallback(page, 3, () => continueShoppingClicks++);
          }
          if (await isProductPage(page)) break;
        }
      }
    };

    await bounceBackToDp();

    // If we are on /dp/ but no title yet, do the explicit click fallback
    if (isDpUrl(page.url()) && !(await hasProductTitle(page))) {
      await trySimpleContinueShoppingFallback(page, 3, () => continueShoppingClicks++);
    }

    // Final product check
    let productLike = await isProductPage(page);

    // If we're still not on a product page and know ASIN, one final bounce-to-dp
    if (!productLike && intendedDpUrl) {
      nonProductCount++;
      nonProductUrls.push(page.url());
      await safeGoto(page, intendedDpUrl, { retries: 1, timeout: 60000 });
      await handleContinueShopping(page, context, intendedDpUrl, () => continueShoppingClicks++);
      if (!(await hasProductTitle(page))) {
        await trySimpleContinueShoppingFallback(page, 3, () => continueShoppingClicks++);
      }
      productLike = await isProductPage(page);
    }

    // Take screenshot (for both success and non-product shapes)
    let buf;
    try {
      buf = await safeScreenshot(page, { type: "png" }, 1);
    } catch (e) {
      if (isClosedErr(e)) {
        page = await adoptActivePageOrThrow(page, context);
        buf = await safeScreenshot(page, { type: "png" }, 1);
      } else {
        throw e;
      }
    }
    const base64 = buf.toString("base64");

    // If it's NOT a product page: return the product-shaped JSON with Unspecifieds
    if (!productLike) {
      return res.json({
        ok: true,
        url: returnUrl,
        pageType: "product",
        ASIN: asin || "Unspecified",
        title: "Unspecified",
        brand: "Unspecified",
        itemForm: "Unspecified",
        price: "Unspecified",
        priceGemini: "Unspecified",
        featuredBullets: "Unspecified",
        productDescription: "Unspecified",
        mainImageUrl: "Unspecified",
        additionalImageUrls: [],
        nonProductCount,
        nonProductUrls,
        continueShoppingClicks,
        screenshot: base64,
      });
    }

    // Otherwise scrape DOM + OCR
    const scraped = await scrapeProductData(page);
    ensureAlive(page, "Page closed before OCR");
    const gem = await geminiExtract(base64);
    const priceGemini = normalizeGeminiPrice(gem.price, scraped.price);

    res.json({
      ok: true,
      url: page.url() || returnUrl,
      pageType: "product",
      ASIN: asin || "Unspecified",
      title: scraped.title || "Unspecified",
      brand: gem.brand || "Unspecified",
      itemForm: scraped.itemForm || "Unspecified",
      price: scraped.price || "Unspecified",
      priceGemini: priceGemini || "Unspecified",
      featuredBullets: scraped.featuredBullets || "Unspecified",
      productDescription: scraped.productDescription || "Unspecified",
      mainImageUrl: scraped.mainImageUrl || "Unspecified",
      additionalImageUrls: scraped.additionalImageUrls || [],
      nonProductCount,
      nonProductUrls,
      continueShoppingClicks,
      screenshot: base64,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    try {
      for (const p of context?.pages?.() || []) {
        try { if (!p.isClosed()) await p.close({ runBeforeUnload: false }); } catch {}
      }
    } catch {}
    try { await browser?.close(); } catch {}
  }
});

/* ------------------------------- Utilities -------------------------------- */
async function safeScreenshot(page, opts = { type: "png" }, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    ensureAlive(page, "Page closed before screenshot");
    try {
      return await page.screenshot(opts);
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) || String(err);
      if (/Target page, context or browser has been closed/i.test(msg)) {
        throw new Error("Screenshot failed: " + msg);
      }
      if (i < retries) {
        await sleep(jitter(250, 500));
        continue;
      }
      throw new Error("Screenshot failed: " + msg);
    }
  }
  throw lastErr || new Error("Screenshot failed");
}

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
  } catch {
    return false;
  }
}

async function extractLinksAndButtons(page, limits = { maxLinks: 300, maxButtons: 300 }) {
  return await page.evaluate((limits) => {
    const toAbs = (u) => {
      try {
        return u ? new URL(u, location.href).href : "";
      } catch {
        return u || "";
      }
    };
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
    const seenL = new Set();
    const dedupLinks = [];
    for (const l of links) {
      const k = `${l.href}|${l.text}`;
      if (l.href && !seenL.has(k)) {
        seenL.add(k);
        dedupLinks.push(l);
      }
    }
    const seenB = new Set();
    const dedupButtons = [];
    for (const b of buttons) {
      const k = `${b.text}|${b.id}`;
      if (!seenB.has(k)) {
        seenB.add(k);
        dedupButtons.push(b);
      }
    }

    return { links: dedupLinks, buttons: dedupButtons, counts: { links: links.length, buttons: buttons.length } };
  }, limits);
}

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Running on port ${PORT}`);
});
