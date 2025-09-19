// index.js
// Express + Playwright + Gemini OCR + CamelCamelCamel (with fallback)
// Amazon: DOM scrape + Gemini OCR (brand/price)  → /scrape
// CamelCamelCamel: product_fields table scrape    → /camel
//
// GET /scrape?url=...&mode=product|links
// GET /camel?url=...

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
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * Minimal Playwright context
 */
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

  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
  });

  // Return context so we can adopt new pages/popups later
  return { browser, context, page };
}

/**
 * Simple helpers
 */
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
    if (
      /enter the characters/i.test(bodyText) ||
      /type the characters/i.test(bodyText) ||
      /sorry/i.test(bodyText)
    ) {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Navigation with retry + CAPTCHA detection
 */
async function safeGoto(page, url, { retries = 2, timeout = 60000 } = {}) {
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    try {
      await sleep(jitter(250, 500));
      await page.goto(url, { timeout, waitUntil: "commit" });
      await sleep(jitter(700, 600));

      if (await looksBlocked(page)) {
        throw new Error("Blocked by CAPTCHA/anti-bot");
      }
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

/**
 * Close the "Added to Cart" side sheet if visible (Amazon)
 */
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

/**
 * Detect & click "Continue/Keep shopping" if present (Amazon)
 */
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

/**
 * Handle "Continue/Keep shopping" and return alive page (Amazon)
 */
async function handleContinueShopping(page, context, fallbackUrl) {
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
    if (fallbackUrl) {
      await safeGoto(fresh, fallbackUrl, { retries: 1, timeout: 60000 });
    }
    return fresh;
  } catch {
    try {
      const adopted = await adoptActivePageOrThrow(page, context);
      return adopted;
    } catch {
      const fresh = await context.newPage();
      try { await fresh.bringToFront(); } catch {}
      if (fallbackUrl) {
        await safeGoto(fresh, fallbackUrl, { retries: 1, timeout: 60000 });
      }
      return fresh;
    }
  }
}

/**
 * Safer screenshot with a small retry
 */
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

/**
 * Heuristic: are we on a proper Amazon product page?
 */
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

/**
 * Extract all <a> and button-like elements (used on non-product pages)
 */
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

    // Simple de-dupe
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

    return {
      links: dedupLinks,
      buttons: dedupButtons,
      counts: { links: links.length, buttons: buttons.length },
    };
  }, limits);
}

/**
 * Scrape product data from DOM (Playwright-only fields) — AMAZON
 * NOTE: Brand is NOT scraped here (Gemini OCR handles brand).
 */
async function scrapeProductData(page) {
  const title =
    (await page.textContent("#productTitle").catch(() => null)) ||
    (await page.textContent("#title").catch(() => null));

  return await page.evaluate((title) => {
    // -------- Item Form (prefer Product Overview row .po-item_form) --------
    const itemForm = (() => {
      // 1) Primary: <tr class="... po-item_form ..."> → value in 2nd <td>
      const row =
        document.querySelector("tr.po-item_form") ||
        document.querySelector('tr[class*="po-item_form"]');
      if (row) {
        const tds = row.querySelectorAll("td");
        if (tds.length >= 2) {
          const text = (tds[1].innerText || tds[1].textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          if (text) return text;
        }
      }
      // 2) Any row where first <td> label contains "Item Form"
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
            .replace(/\s+/g, " ")
            .trim();
          if (text) return text;
        }
      }
      // 3) Fallback: bullet or list: "Item Form: Lotion"
      const li = Array.from(
        document.querySelectorAll("#detailBullets_feature_div li, li")
      ).find((el) => /item\s*form/i.test(el.innerText || el.textContent || ""));
      if (li) {
        const raw = (li.innerText || li.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const m = raw.match(/item\s*form\s*[:\-]?\s*(.+)$/i);
        if (m && m[1]) return m[1].trim();
      }
      return "";
    })();

    // -------- Price (ensure currency) --------
    const getPriceWithCurrency = () => {
      const priceEl =
        document.querySelector(".a-price .a-offscreen") ||
        document.querySelector("#priceblock_ourprice, #priceblock_dealprice, #priceblock_saleprice");
      let text = (priceEl?.textContent || "").trim();

      const hasCurrency = /[\p{Sc}]|\b[A-Z]{3}\b/u.test(text);
      if (text && !hasCurrency) {
        const sym = document.querySelector(".a-price .a-price-symbol")?.textContent?.trim() || "";
        if (sym) {
          text = sym + text;
        } else {
          const iso =
            document
              .querySelector('meta[property="og:price:currency"]')
              ?.getAttribute("content") || "";
          if (iso) text = iso + " " + text;
        }
      }
      return text || "";
    };
    const price = getPriceWithCurrency();

    // -------- Featured bullets (each item prefixed with "• " and suffixed with " ") --------
    const featuredBullets = (() => {
      const items = Array.from(document.querySelectorAll("#feature-bullets ul li"))
        .map((li) => (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((text) => `• ${text} `);
      return items.length ? items.join("") : "";
    })();

    // -------- Product Description --------
    const productDescription = (() => {
      const el = document.querySelector("#productDescription");
      if (!el) return "";
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    })();

    // -------- Images --------
    const mainImageUrl = (() => {
      const imgTag = document.querySelector("#landingImage") || document.querySelector("#imgTagWrapperId img");
      if (imgTag) return imgTag.getAttribute("src") || "";
      return "";
    })();

    // Normalize thumbnail -> base jpg (do not force AC_SL here)
    const normalizeImageUrl = (url) => {
      if (!url) return "";
      return url.replace(/\._[A-Z0-9_,]+\_\.jpg/i, ".jpg");
    };
    const normalizedMain = normalizeImageUrl((mainImageUrl || "").trim());

    // Collect candidate URLs from visible thumbs
    let additionalImageUrls = Array.from(document.querySelectorAll("#altImages img, .imageThumb img"))
      .map((img) => img.getAttribute("src") || "")
      .map((src) => (src || "").trim())
      .filter(Boolean);

    // Also inspect landing image attributes
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

    // Scan entire document for hi-res URLs ending with ._AC_SL{digits}_.jpg
    const hiResMatches = Array.from(
      document.documentElement.innerHTML.matchAll(
        /https:\/\/[^"\s]+?\._AC_SL\d+_\.jpg(?:\?[^"\s]*)?/gi
      )
    ).map((m) => m[0]);

    additionalImageUrls = [...new Set([...additionalImageUrls, ...hiResMatches])];

    // Remove obvious junk thumbs/sprites/overlays
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

    // Final pass: keep ANY _AC_SL{n}_ size, drop main
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

/**
 * Gemini OCR extraction (Brand + Price with currency)
 */
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

// ---------- Common utilities ----------
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
function coerceASIN(input = "") {
  const s = String(input || "").trim();
  const fromUrl = extractASINFromUrl(s);
  if (fromUrl) return fromUrl;
  const m = s.match(/^[A-Z0-9]{8,10}$/i);
  return m ? m[0].toUpperCase() : "";
}

function includesCurrency(s = "") {
  return /[\p{Sc}]|\b[A-Z]{3}\b/u.test(s);
}
function currencyToken(s = "") {
  const m = s.match(/([\p{Sc}]|\b[A-Z]{3}\b)/u);
  return m ? m[1] : "";
}

/**
 * Normalize Gemini price strings (fix superscripts, etc.)
 */
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

/* ===========================
   CamelCamelCamel helpers
   =========================== */

// Detect Camel's verification/challenge page
async function isCamelVerificationGate(page) {
  try {
    const { inner, hasCf } = await page.evaluate(() => {
      const inner = (document.body?.innerText || "").toLowerCase();
      const hasCf =
        !!document.querySelector("#challenge-running, #challenge-stage, .cf-challenge, [data-cf]") ||
        /challenge-platform|turnstile|cloudflare/i.test(document.documentElement.outerHTML);
      return { inner, hasCf };
    });
    return (
      hasCf ||
      inner.includes("verifying you are human") ||
      inner.includes("checking your browser before accessing")
    );
  } catch {
    return false;
  }
}

// Fallback: fetch similar fields from Amazon by ASIN
async function scrapeAmazonFieldsByASIN(context, asin) {
  const page = await context.newPage();
  const url = `https://www.amazon.com/dp/${asin}`;
  await safeGoto(page, url, { retries: 1, timeout: 60000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});

  const vals = await page.evaluate(() => {
    const clean = (s) =>
      (s || "")
        .replace(/\u00AD|\u200B|\u2060|\uFEFF/g, "") // soft hyphen/ZW spaces
        .replace(/\u00A0/g, " ")                     // nbsp -> space
        .replace(/\s+/g, " ")
        .trim();

    // Search common product detail tables + bullet lists
    const findInTables = (labelRe) => {
      const scopes = [
        "#productDetails_techSpec_section_1",
        "#productDetails_detailBullets_sections1",
        "#prodDetails",
        ".prodDetTable",
        "#detailBullets_feature_div",
      ];
      for (const sel of scopes) {
        const root = document.querySelector(sel);
        if (!root) continue;

        // table rows
        const rows = Array.from(root.querySelectorAll("tr"));
        for (const tr of rows) {
          const cells = tr.querySelectorAll("th,td");
          if (cells.length < 2) continue;
          const label = clean(cells[0].innerText || cells[0].textContent || "");
          const value = clean(cells[1].innerText || cells[1].textContent || "");
          if (labelRe.test(label)) return value;
        }
        // bullet-style "Label: Value"
        const bullets = Array.from(root.querySelectorAll("li"));
        for (const li of bullets) {
          const txt = clean(li.innerText || li.textContent || "");
          const m = txt.match(/^([^:]+):\s*(.+)$/);
          if (m && labelRe.test(m[1])) return clean(m[2]);
        }
      }
      return "";
    };

    // Breadcrumbs for product group/category
    const crumbs = Array.from(
      document.querySelectorAll("#wayfinding-breadcrumbs_feature_div ul li a")
    )
      .map((a) => clean(a.innerText || a.textContent || ""))
      .filter(Boolean);

    const productGroup = crumbs[0] || "";
    const category = crumbs.join(" > ") || "";

    const manufacturer =
      findInTables(/manufacturer/i) || clean(document.querySelector("#bylineInfo")?.innerText || "");

    // “List Price” sometimes appears in tables or price box (strikethrough)
    const listPrice =
      findInTables(/list\s*price/i) || clean(document.querySelector("#price .a-text-price")?.innerText || "");

    const upc = findInTables(/\bUPC\b/i);

    return { productGroup, category, manufacturer, listPrice, upc };
  });

  let shot = "";
  try {
    const buf = await page.screenshot({ type: "png" });
    shot = buf.toString("base64");
  } catch {}
  try { await page.close(); } catch {}

  return { ...vals, screenshot: shot, url };
}

// ---------- endpoints ----------
app.get("/", (req, res) => {
  res.send("✅ Scraper is up (Amazon + CamelCamelCamel).");
});

/**
 * AMAZON endpoint
 * Supports mode=product (default) and mode=links
 */
app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  const mode = String(req.query.mode || "product").toLowerCase(); // "product" | "links"
  const force = req.query.force === "1" || req.query.force === "true";

  if (!url) return res.status(400).json({ ok: false, error: "Missing url param" });

  const width = 1280, height = 800;

  let browser, context, page;
  try {
    const ctx = await minimalContext(width, height);
    browser = ctx.browser;
    context = ctx.context;
    page = ctx.page;

    // Navigate & handle side-sheets/continue shopping
    await safeGoto(page, url, { retries: 2, timeout: 60000 });
    page = await handleContinueShopping(page, context, url);
    ensureAlive(page, "Page closed after continue-shopping handling (reloaded)");

    // Decide page type once (used by both modes)
    let productLike;
    try {
      productLike = await isProductPage(page);
    } catch (e) {
      if (isClosedErr(e)) {
        page = await adoptActivePageOrThrow(page, context);
        await sleep(200);
        productLike = await isProductPage(page);
      } else {
        throw e;
      }
    }

    // ---------- MODE: LINKS ----------
    if (mode === "links") {
      if (productLike && !force) {
        const buf = await safeScreenshot(page, { type: "png" }, 1);
        return res.json({
          ok: true,
          url: page.url(),
          pageType: "product",
          note: 'On product page; skipping links/buttons (pass ?force=1 to override).',
          screenshot: buf.toString("base64"),
          counts: { links: 0, buttons: 0 },
          links: [],
          buttons: [],
        });
      }

      const { links, buttons, counts } = await extractLinksAndButtons(page).catch(() => ({
        links: [],
        buttons: [],
        counts: { links: 0, buttons: 0 },
      }));
      const buf = await safeScreenshot(page, { type: "png" }, 1);

      return res.json({
        ok: true,
        url: page.url(),
        pageType: productLike ? "product" : "nonProduct",
        counts,
        links,
        buttons,
        screenshot: buf.toString("base64"),
      });
    }

    // ---------- MODE: PRODUCT (default) ----------
    await sleep(jitter(300, 400));

    // Scrape Playwright fields (retry once if page was swapped)
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

    // Gemini OCR (brand + price) and price normalization
    const gemini = await geminiExtract(base64);
    const priceGemini = normalizeGeminiPrice(gemini.price, scraped.price);

    // ASIN & final response
    const resolvedUrl = page.url() || url;
    const asin = extractASINFromUrl(resolvedUrl) || extractASINFromUrl(url);

    return res.json({
      ok: true,
      url: resolvedUrl,
      pageType: productLike ? "product" : "nonProduct",
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
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    try { for (const p of context?.pages?.() || []) if (!p.isClosed()) await p.close({ runBeforeUnload: false }); } catch {}
    try { await browser?.close(); } catch {}
  }
});

/**
 * CAMELCAMELCAMEL endpoint (with verification detection + Amazon fallback)
 * /camel?url=<amazon-url-or-asin>
 */
app.get("/camel", async (req, res) => {
  const inputUrl = req.query.url || "";
  const asin = coerceASIN(inputUrl);
  if (!asin) {
    return res.status(400).json({ ok: false, error: "Could not determine ASIN from url" });
  }

  const camelUrl = `https://camelcamelcamel.com/product/${asin}`;
  const width = 1280, height = 800;

  let browser, context, page;
  try {
    const ctx = await minimalContext(width, height);
    browser = ctx.browser;
    context = ctx.context;
    page = ctx.page;

    await safeGoto(page, camelUrl, { retries: 2, timeout: 60000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});

    // Give the challenge a brief chance to auto-complete
    await page
      .waitForFunction(
        () => !/verifying you are human/i.test(document.body?.innerText || ""),
        { timeout: 8000 }
      )
      .catch(() => null);

    const challenged = await isCamelVerificationGate(page);

    if (challenged) {
      // Fallback to Amazon-derived values
      const fb = await scrapeAmazonFieldsByASIN(context, asin);
      return res.json({
        ok: true,
        source: "amazon-fallback",
        url: fb.url,
        ASIN: asin,
        productGroup: fb.productGroup || "Unspecified",
        category: fb.category || "Unspecified",
        manufacturer: fb.manufacturer || "Unspecified",
        priceCamel: fb.listPrice || "Unspecified",
        upc: fb.upc || "Unspecified",
        screenshot: fb.screenshot || "",
        note: "Camel blocked by verification; returned Amazon-derived fields instead.",
      });
    }

    // Not challenged → parse Camel table
    const details = await page.evaluate(() => {
      const cleanText = (node) =>
        (node?.innerText || node?.textContent || "")
          .replace(/\u00AD|\u200B|\u2060|\uFEFF/g, "") // soft hyphen/ZW spaces
          .replace(/\u00A0/g, " ")                    // nbsp -> space
          .replace(/\s+/g, " ")
          .trim();

      const out = { productGroup: "", category: "", manufacturer: "", listPrice: "", upc: "" };
      const table = document.querySelector("table.product_fields");
      if (!table) return out;

      const rows = Array.from(table.querySelectorAll("tr"));
      for (const tr of rows) {
        const tds = tr.querySelectorAll("td");
        if (tds.length < 2) continue;

        const label = cleanText(tds[0]).toLowerCase();
        const value = cleanText(tds[1]);

        if (!label) continue;
        if (/product\s*group/.test(label)) out.productGroup = value;
        else if (/category/.test(label)) out.category = value;
        else if (/manufacturer/.test(label)) out.manufacturer = value;
        else if (/list\s*price/.test(label)) out.listPrice = value;
        else if (/\bupc\b/.test(label)) out.upc = value;
      }
      return out;
    });

    const buf = await safeScreenshot(page, { type: "png" }, 1);
    const base64 = buf.toString("base64");

    return res.json({
      ok: true,
      source: "camel",
      url: camelUrl,
      ASIN: asin,
      productGroup: details.productGroup || "Unspecified",
      category: details.category || "Unspecified",
      manufacturer: details.manufacturer || "Unspecified",
      priceCamel: details.listPrice || "Unspecified",
      upc: details.upc || "Unspecified",
      screenshot: base64,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    try { for (const p of context?.pages?.() || []) if (!p.isClosed()) await p.close({ runBeforeUnload: false }); } catch {}
    try { await browser?.close(); } catch {}
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Running on port ${PORT}`);
});
