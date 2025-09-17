// index.js
// Express + Playwright + Gemini OCR
// Scrapes Amazon product info via DOM + Gemini OCR on screenshot
//
// GET /scrape?url=...

import express from "express";
import { chromium } from "playwright";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 8080;

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
 * - waitUntil: 'commit' to avoid long loads
 * - timeout: 60s
 * - retries: 2 (total 3 attempts)
 */
async function safeGoto(page, url, { retries = 2, timeout = 60000 } = {}) {
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    try {
      await sleep(jitter(250, 500)); // slight jitter
      await page.goto(url, { timeout, waitUntil: "commit" });
      await sleep(jitter(700, 600)); // let initial HTML render

      if (await looksBlocked(page)) {
        throw new Error("Blocked by Amazon CAPTCHA/anti-bot");
      }
      return; // success
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
 * Detect & click "Continue shopping" if present
 */
async function clickContinueShoppingIfPresent(page) {
  const KNOWN_SELECTORS = [
    '#hlb-continue-shopping-announce',
    'a#hlb-continue-shopping-announce',
    '#continue-shopping',
    'button#continue-shopping',
    'a[href*="continueShopping"]',
    'button[name*="continueShopping"]',
    'input[type="submit"][value*="Continue shopping" i]',
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
      'button:has-text("Continue shopping"), a:has-text("Continue shopping"), [role="button"]:has-text("Continue shopping")'
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
        return txt.includes("continue shopping");
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
 * Handle "Continue shopping" flows and ADOPT a new page if one opens
 * Returns the active page (may be a different Page instance)
 */
async function handleContinueShopping(page, context) {
  const clicked = await clickContinueShoppingIfPresent(page);
  if (!clicked) return page;

  // Wait for either navigation or a popup/new page
  const popupPromise = context
    .waitForEvent("page", { timeout: 8000 })
    .catch(() => null);
  const navPromise = page
    .waitForNavigation({ timeout: 15000, waitUntil: "commit" })
    .catch(() => null);
  const dclPromise = page
    .waitForLoadState("domcontentloaded", { timeout: 15000 })
    .catch(() => null);

  await Promise.race([popupPromise, navPromise, dclPromise]);

  // Prefer a newly opened, alive page that is not about:blank
  const pages = context.pages();
  const active = pages.find((p) => !p.isClosed() && p.url() !== "about:blank");
  if (active && active !== page) {
    await active.bringToFront().catch(() => {});
    return active;
  }

  // If the current page died, fallback to any alive page
  if (page.isClosed()) {
    const fallback = pages.find((p) => !p.isClosed());
    if (fallback) return fallback;
    throw new Error("Page closed after continue-shopping handling");
  }

  // If the button still appears, reload once
  try {
    const stillThere = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('button, a, input[type="submit"], div[role="button"]')
      );
      return nodes.some((n) =>
        ((n.innerText || n.value || "") + "")
          .toLowerCase()
          .includes("continue shopping")
      );
    });
    if (stillThere) {
      await page.reload({ timeout: 20000, waitUntil: "commit" }).catch(() => {});
      await page
        .waitForLoadState("domcontentloaded", { timeout: 10000 })
        .catch(() => {});
    }
  } catch {}

  return page;
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
      const canonical =
        document.querySelector('link[rel="canonical"]')?.href || "";
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

      const layoutHints =
        !!document.querySelector("#dp, #dp-container, #ppd, #centerCol, #leftCol");

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
 * Scrape product data from DOM (Playwright-only fields)
 * - Title
 * - Item Form
 * - Price (ensure currency)
 * - Featured Bullets (each "• text ")
 * - Product Description
 * - Main Image URL
 * - Additional Images URLs
 *
 * NOTE: Brand is NOT scraped here (Gemini OCR handles brand).
 */
async function scrapeProductData(page) {
  const title =
    (await page.textContent("#productTitle").catch(() => null)) ||
    (await page.textContent("#title").catch(() => null));

  return await page.evaluate((title) => {
    // -------- Item Form --------
    const itemForm = (() => {
      const li = Array.from(document.querySelectorAll("li")).find((el) =>
        (el.textContent || "").toLowerCase().includes("item form")
      );
      if (li) {
        const parts = (li.textContent || "").split(":");
        if (parts.length > 1) return parts.slice(1).join(":").trim();
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
      const items = Array.from(
        document.querySelectorAll("#feature-bullets ul li")
      )
        .map((li) =>
          (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim()
        )
        .filter(Boolean)
        .map((text) => `• ${text} `); // bullet at start, space at end
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
      const imgTag =
        document.querySelector("#landingImage") ||
        document.querySelector("#imgTagWrapperId img");
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
    let additionalImageUrls = Array.from(
      document.querySelectorAll("#altImages img, .imageThumb img")
    )
      .map((img) => img.getAttribute("src") || "")
      .map((src) => (src || "").trim())
      .filter(Boolean);

    // Also inspect landing image attributes
    const landing =
      document.querySelector("#landingImage") ||
      document.querySelector("#imgTagWrapperId img");

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

    // 🔍 Scan entire document for hi-res URLs ending with ._AC_SL{digits}_.jpg (allow optional query)
    const hiResMatches = Array.from(
      document.documentElement.innerHTML.matchAll(
        /https:\/\/[^"\s]+?\._AC_SL\d+_\.jpg(?:\?[^"\s]*)?/gi
      )
    ).map((m) => m[0]);

    // Merge, dedupe early
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

    // Final pass:
    // 1) Remove main image if present (base jpg)
    // 2) Keep ANY AC_SL size (_AC_SL1000_, _AC_SL1500_, _AC_SL2000_, etc.)
    const AC_ANY = /\._AC_SL\d+_\.jpg(?:\?.*)?$/i;
    additionalImageUrls = additionalImageUrls
      .filter((url) => url && url !== normalizedMain)
      .filter((url) => AC_ANY.test(url));

    // Dedupe again
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

// ---------- endpoints ----------
app.get("/", (req, res) => {
  res.send("✅ Amazon scraper with Playwright + Gemini OCR is up.");
});

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

function includesCurrency(s = "") {
  return /[\p{Sc}]|\b[A-Z]{3}\b/u.test(s);
}
function currencyToken(s = "") {
  const m = s.match(/([\p{Sc}]|\b[A-Z]{3}\b)/u);
  return m ? m[1] : "";
}

/**
 * Normalize Gemini price strings:
 * - Convert superscripts/subscripts ⁰-⁹ / ₀-₉ to normal digits
 * - If superscripts were present and no decimal, insert dot before last two digits
 * - Turn "34,95" or "34 95" into "34.95"
 * - Preserve or borrow currency (symbol or ISO) if missing
 */
function normalizeGeminiPrice(raw = "", domPrice = "") {
  let s = (raw || "").trim();
  if (!s) return "Unspecified";

  // Normalize spaces
  s = s.replace(/[\u00A0\u2009\u202F]/g, " ");

  const hadSuper = /[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(s);

  // Map superscript/subscript digits to normal digits
  const map = {
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
    "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
    "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
  };
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/g, (ch) => map[ch] || ch);

  // If comma used as decimal: 34,95 -> 34.95 (only when no dot present)
  if (!/\d\.\d{2,}/.test(s) && /(\d+),(\d{2})\b/.test(s)) {
    s = s.replace(/(\d+),(\d{2})\b/, "$1.$2");
  }
  // If space between cents: 34 95 -> 34.95 (only when no dot present)
  if (!/\d\.\d{2,}/.test(s) && /(\d+)\s+(\d{2})\b/.test(s)) {
    s = s.replace(/(\d+)\s+(\d{2})\b/, "$1.$2");
  }

  // If superscripts were present and there's still no decimal, insert before last 2 digits
  if (hadSuper && !/\d\.\d{2,}/.test(s)) {
    const digits = (s.match(/\d+/g) || []).join("");
    if (digits.length >= 3) {
      const num = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
      // Keep any currency token from s (symbol or ISO), else from domPrice
      const cur = currencyToken(s) || currencyToken(domPrice);
      s = cur ? `${cur} ${num}` : num;
    }
  }

  // If still missing currency but DOM has it, borrow
  if (!includesCurrency(s) && includesCurrency(domPrice)) {
    const cur = currencyToken(domPrice);
    if (cur) s = `${cur} ${s}`;
  }

  // Collapse extra spaces
  s = s.replace(/\s+/g, " ").trim();
  return s || "Unspecified";
}

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

    // Hardened navigation with retry + CAPTCHA detection
    await safeGoto(page, url, { retries: 2, timeout: 60000 });
    ensureAlive(page, "Page unexpectedly closed after navigation");

    // Dismiss/handle "Continue shopping" and ADOPT new page if Amazon opens one
    page = await handleContinueShopping(page, context);
    ensureAlive(page, "Page closed after continue-shopping handling");

    // Product page or not?
    const productLike = await isProductPage(page);

    // If NOT a product page: capture screenshot, extract links/buttons, return.
    if (!productLike) {
      const bufNP = await safeScreenshot(page, { type: "png" }, 1);
      const base64NP = bufNP.toString("base64");
      const meta = {
        currentUrl: page.url(),
        title: (await page.title().catch(() => "")) || "",
      };
      const { links, buttons, counts } = await extractLinksAndButtons(page);
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

    // Small pause to stabilize above-the-fold
    await sleep(jitter(500, 500));

    // Scrape Playwright data
    const scraped = await scrapeProductData(page);
    ensureAlive(page, "Page closed before screenshot");

    // Screenshot for OCR (with a small retry)
    const buf = await safeScreenshot(page, { type: "png" }, 1);
    const base64 = buf.toString("base64");

    // Gemini OCR for Brand + Price (with currency)
    const gemini = await geminiExtract(base64);

    // Normalize Gemini price (fix superscripts etc.), borrowing currency from DOM if needed
    let priceGemini = normalizeGeminiPrice(gemini.price, scraped.price);

    // ASIN from final resolved URL
    const resolvedUrl = page.url() || url;
    const asin = extractASINFromUrl(resolvedUrl) || extractASINFromUrl(url);

    // Final JSON
    res.json({
      ok: true,
      url: resolvedUrl,
      pageType: "product",
      ASIN: asin || "Unspecified",
      title: scraped.title || "Unspecified",
      brand: gemini.brand || "Unspecified",               // Gemini OCR
      itemForm: scraped.itemForm || "Unspecified",        // Playwright
      price: scraped.price || "Unspecified",              // Playwright (with currency ensured)
      priceGemini: priceGemini || "Unspecified",          // Gemini OCR normalized
      featuredBullets: scraped.featuredBullets || "Unspecified",
      productDescription: scraped.productDescription || "Unspecified",
      mainImageUrl: scraped.mainImageUrl || "Unspecified",
      additionalImageUrls: scraped.additionalImageUrls || [],
      screenshot: base64,                                  // base64 PNG
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  } finally {
    // Close all pages in context to avoid leaks if a popup was opened
    try {
      for (const p of context?.pages?.() || []) {
        try {
          if (!p.isClosed()) await p.close({ runBeforeUnload: false });
        } catch {}
      }
    } catch {}
    try {
      await browser?.close();
    } catch {}
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Running on port ${PORT}`);
});
