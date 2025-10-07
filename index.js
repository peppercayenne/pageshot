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

// Detect & click "Continue/Keep shopping" if present (overlays or inline)
async function clickContinueShoppingIfPresent(page) {
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
  for (const sel of KNOWN_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => {});
        return true;
      }
    } catch {}
  }
  try {
    const textLoc = page.locator(
      'button:has-text("Continue shopping"), a:has-text("Continue shopping"), [role="button"]:has-text("Continue shopping"), button:has-text("Keep shopping"), a:has-text("Keep shopping")'
    );
    if (await textLoc.first().isVisible({ timeout: 500 }).catch(() => false)) {
      await textLoc.first().click({ timeout: 2000 }).catch(() => {});
      return true;
    }
  } catch {}
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
  } catch {}
  return false;
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

// EXACT request fallback: click literal "Continue Shopping" up to maxTries
async function trySimpleContinueShoppingFallback(page, maxTries = 3, onClick) {
  for (let i = 0; i < maxTries; i++) {
    let clicked = false;
    try {
      await page.click("text=Continue Shopping", { timeout: 1500 });
      clicked = true;
      onClick?.();
    } catch {}
    await Promise.race([
      page.waitForNavigation({ waitUntil: "commit", timeout: 4000 }).catch(() => null),
      page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => null),
    ]);
    if (await hasProductTitle(page)) return true;
    if (!clicked) await sleep(350);
  }
  return false;
}

async function handleContinueShopping(page, context, fallbackUrl, onClick) {
  try {
    const clicked = await clickContinueShoppingIfPresent(page);
    if (!clicked) return page;

    const popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
    const navPromise = page.waitForNavigation({ timeout: 15000, waitUntil: "commit" }).catch(() => null);
    const dclPromise = page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
    await Promise.race([popupPromise, navPromise, dclPromise]);

    const pages = context.pages();
    const active = pages.find((p) => !p.isClosed() && p.url() !== "about:blank");
    if (active && active !== page) {
      try { await active.bringToFront(); } catch {}
      return active;
    }
    if (page && !page.isClosed()) return page;

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

/* ------------------------------ Product scrape ---------------------------- */
async function scrapeProductData(page) {
  const title =
    (await page.textContent("#productTitle").catch(() => null)) ||
    (await page.textContent("#title").catch(() => null));

  return await page.evaluate((title) => {
    /* -------- Item Form -------- */
    const itemForm = (() => {
      const row =
        document.querySelector("tr.po-item_form") ||
        document.querySelector('tr[class*="po-item_form"]');
      if (row) {
        const tds = row.querySelectorAll("td");
        if (tds.length >= 2) {
          const text = (tds[1].innerText || tds[1].textContent || "")
            .replace(/\s+/g, " ").trim();
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
          const text = (tds[1].innerText || tds[1].textContent || "")
            .replace(/\s+/g, " ").trim();
          if (text) return text;
        }
      }
      const li = Array.from(
        document.querySelectorAll("#detailBullets_feature_div li, li")
      ).find((el) => /item\s*form/i.test(el.innerText || el.textContent || ""));
      if (li) {
        const raw = (li.innerText || li.textContent || "")
          .replace(/\s+/g, " ").trim();
        const m = raw.match(/item\s*form\s*[:\-]?\s*(.+)$/i);
        if (m && m[1]) return m[1].trim();
      }
      return "";
    })();

    /* -------- Price (ensure currency) -------- */
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

    /* -------- Featured bullets -------- */
    const featuredBullets = (() => {
      const items = Array.from(document.querySelectorAll("#feature-bullets ul li"))
        .map((li) => (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((text) => `• ${text} `);
      return items.length ? items.join("") : "";
    })();

    /* -------- Product Description -------- */
    const productDescription = (() => {
      const el = document.querySelector("#productDescription");
      if (!el) return "";
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    })();

    /* -------- Rating & Review Count -------- */
    const reviewCount = (() => {
      const el = document.querySelector("#acrCustomerReviewText");
      if (!el) return "";
      const n = (el.innerText || el.textContent || "").replace(/[^\d]/g, "");
      return n || "";
    })();

    const rating = (() => {
      const el = document.querySelector("#acrPopover");
      const titleAttr = el?.getAttribute("title") || "";
      const cleaned = titleAttr.replace(/out of 5 stars/i, "").replace(/\s+/g, " ").trim();
      return cleaned || "";
    })();

    /* -------- Date First Available (detail bullets) — return ONLY the date -------- */
    const dateFirstAvailable = (() => {
      const container = document.querySelector("#detailBullets_feature_div");
      if (!container) return "";
      const li = Array.from(container.querySelectorAll("li")).find((node) => {
        const label = (node.querySelector("span.a-text-bold")?.innerText || node.innerText || node.textContent || "");
        return /date\s*first\s*available/i.test(label);
      });
      if (!li) return "";

      const DATE_RE = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/;

      // 1) Ideal case: bold label span → take its next sibling span’s text
      const bold = li.querySelector("span.a-text-bold");
      if (bold) {
        let sib = bold.nextElementSibling;
        // skip RTL/LRM text nodes packaged in spans that are just punctuation
        while (sib && sib.tagName?.toLowerCase() === "span" && !DATE_RE.test(sib.textContent || "")) {
          sib = sib.nextElementSibling;
        }
        const val = (sib && sib.textContent) ? sib.textContent.trim() : "";
        const m = val.match(DATE_RE);
        if (m) return m[0];
      }

      // 2) Fallback: look at all non-bold spans inside this <li>
      const spans = Array.from(li.querySelectorAll("span")).filter((s) => !s.classList.contains("a-text-bold"));
      for (const s of spans) {
        const t = (s.innerText || s.textContent || "").trim();
        const m = t.match(DATE_RE);
        if (m) return m[0];
      }

      // 3) Final fallback: extract from the whole <li> text
      const full = (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim();
      const m = full.match(DATE_RE);
      return (m && m[0]) || "";
    })();

    /* -------- Release date fallback (prodDetails table) -------- */
    const releaseDate = (() => {
      const root = document.querySelector("#prodDetails");
      if (!root) return "";
      const rows = Array.from(root.querySelectorAll("tr"));
      for (const tr of rows) {
        const th = tr.querySelector("th");
        const td = tr.querySelector("td");
        if (!th || !td) continue;
        const label = (th.innerText || th.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (/release\s*date|date\s*released|date\s*of\s*release/i.test(label)) {
          const val = (td.innerText || td.textContent || "").replace(/\s+/g, " ").trim();
          const m = val.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/);
          return (m && m[0]) || val;
        }
      }
      return "";
    })();

    /* -------- Main Image (unchanged) -------- */
    const mainImageUrl = (() => {
      const imgTag = document.querySelector("#landingImage") || document.querySelector("#imgTagWrapperId img");
      if (imgTag) return imgTag.getAttribute("src") || "";
      return "";
    })();
    const normalizeImageUrl = (url) => (url ? url.replace(/\._[A-Z0-9_,]+\_\.jpg/i, ".jpg") : "");
    const normalizedMain = normalizeImageUrl((mainImageUrl || "").trim());

    /* -------- Additional Images: ONLY from ImageBlockATF scripts, _AC_SL only -------- */
    const additionalImageUrls = (() => {
      const AC_SL = /https:\/\/[^"\s]+?\._AC_SL\d+_\.jpg(?:\?[^"\s]*)?/gi;
      const scripts = Array.from(document.querySelectorAll("script"));
      const urls = new Set();
      for (const s of scripts) {
        const txt = s.textContent || "";
        if (!/register\(["']ImageBlockATF["']/.test(txt)) continue;
        const matches = txt.match(AC_SL) || [];
        for (const m of matches) {
          const clean = m.split("?")[0];
          if (clean && clean !== normalizedMain) urls.add(clean);
        }
      }
      return Array.from(urls);
    })();

    // Final date: prefer Date First Available, else Release date
    const finalDateFirstAvailable = dateFirstAvailable || releaseDate || "";

    return {
      title: (title || "").trim(),
      itemForm: (itemForm || "").trim(),
      price: (price || "").trim(),
      featuredBullets: (featuredBullets || "").trim(),
      productDescription: (productDescription || "").trim(),
      mainImageUrl: normalizedMain || "",
      additionalImageUrls,
      reviewCount,
      rating,
      dateFirstAvailable: finalDateFirstAvailable,
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
  const returnUrl = intendedDpUrl || inputUrl;

  let browser, context, page;
  let detourBounceAttempts = 0;
  const MAX_DETOUR_BOUNCES = 3;

  try {
    const ctx = await minimalContext(width, height);
    browser = ctx.browser;
    context = ctx.context;
    page = ctx.page;

    // First nav
    await safeGoto(page, inputUrl, { retries: 2, timeout: 60000 });
    ensureAlive(page, "Page unexpectedly closed after navigation");

    // Bounce back to dp if detoured (with small settle delay)
    const bounceBackToDp = async () => {
      if (!intendedDpUrl) return;
      for (let i = 0; i < MAX_DETOUR_BOUNCES; i++) {
        await sleep(300);
        const curUrl = page.url();
        if (isDpUrl(curUrl)) break;
        if (isLikelyDetourUrl(curUrl) || !isDpUrl(curUrl)) {
          detourBounceAttempts++;
          await safeGoto(page, intendedDpUrl, { retries: 1, timeout: 60000 });
          page = await handleContinueShopping(page, context, intendedDpUrl, null);
          if (await hasProductTitle(page)) break;
        } else {
          break;
        }
      }
    };
    await bounceBackToDp();

    // If on /dp/ but no title yet, simple fallback
    if (isDpUrl(page.url()) && !(await hasProductTitle(page))) {
      await trySimpleContinueShoppingFallback(page, 3, null);
    }

    // Final product check; if not product after bounces, return nonProduct JSON
    let productLike = await isProductPage(page);
    if (!productLike) {
      if (intendedDpUrl && detourBounceAttempts < MAX_DETOUR_BOUNCES) {
        detourBounceAttempts++;
        await safeGoto(page, intendedDpUrl, { retries: 1, timeout: 60000 });
        page = await handleContinueShopping(page, context, intendedDpUrl, null);
        productLike = await isProductPage(page);
      }
    }

    if (!productLike) {
      let bufNP;
      try {
        bufNP = await safeScreenshot(page, { type: "png" }, 1);
      } catch (e) {
        if (isClosedErr(e)) {
          page = await adoptActivePageOrThrow(page, context);
          bufNP = await safeScreenshot(page, { type: "png" }, 1);
        } else {
          throw e;
        }
      }
      const base64NP = bufNP.toString("base64");
      return res.json({
        ok: true,
        url: page.url() || returnUrl,
        pageType: "nonProduct",
        detourBounceAttempts,
        screenshot: base64NP,
      });
    }

    // Handle any “continue shopping” loops inline
    for (let i = 0; i < 3; i++) {
      const before = page.url();
      const handled = await clickContinueShoppingIfPresent(page);
      if (!handled) break;
      await Promise.race([
        page.waitForNavigation({ waitUntil: "commit", timeout: 8000 }).catch(() => null),
        page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => null),
      ]);
      const after = page.url();
      if (await hasProductTitle(page)) break;
      if (after === before) await sleep(350);
    }

    await sleep(jitter(300, 400));

    // Scrape DOM
    let scraped;
    try {
      scraped = await scrapeProductData(page);
    } catch (e) {
      if (isClosedErr(e)) {
        page = await adoptActivePageOrThrow(page, context);
        await sleep(200);
        scraped = await scrapeProductData(page);
      } else {
        throw e;
      }
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
      } else {
        throw e;
      }
    }
    const base64 = buf.toString("base64");

    // OCR brand + price
    const gem = await geminiExtract(base64);
    const priceGemini = normalizeGeminiPrice(gem.price, scraped.price);

    // ASIN from final URL (or input as fallback)
    const resolvedUrl = page.url() || returnUrl;
    const finalAsin = extractASINFromUrl(resolvedUrl) || extractASINFromUrl(inputUrl);

    // Final JSON
    res.json({
      ok: true,
      url: resolvedUrl,
      pageType: "product",
      ASIN: finalAsin || "Unspecified",
      title: scraped.title || "Unspecified",
      brand: gem.brand || "Unspecified",
      itemForm: scraped.itemForm || "Unspecified",
      price: scraped.price || "Unspecified",
      priceGemini: priceGemini || "Unspecified",
      featuredBullets: scraped.featuredBullets || "Unspecified",
      productDescription: scraped.productDescription || "Unspecified",
      mainImageUrl: scraped.mainImageUrl || "Unspecified",
      additionalImageUrls: scraped.additionalImageUrls || [],
      reviewCount: scraped.reviewCount || "Unspecified",
      rating: scraped.rating || "Unspecified",
      dateFirstAvailable: scraped.dateFirstAvailable || "Unspecified",
      screenshot: base64,
      detourBounceAttempts,
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

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Running on port ${PORT}`);
});
