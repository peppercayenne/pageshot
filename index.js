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

    // Quick body sniff (don’t rely on loaded selectors)
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
 * Extract all <a> and button-like elements (only used on non-product pages)
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

    // Simple de-dupe by (href + text) for links; (text + id) for buttons
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
 * Scrape product data from DOM
 */
async function scrapeProductData(page) {
  const title =
    (await page.textContent("#productTitle").catch(() => null)) ||
    (await page.textContent("#title").catch(() => null));

  return await page.evaluate((title) => {
    const brand = (() => {
      const byline = document.querySelector("#bylineInfo");
      if (byline) return byline.textContent.trim();
      return "";
    })();

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

    let price = "";
    const candidates = Array.from(
      document.querySelectorAll(".a-price .a-offscreen")
    )
      .map((el) => (el.textContent || "").trim())
      .filter((t) => /^\$?\d/.test(t));
    if (candidates.length) {
      price = candidates[0];
    }

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
      brand: brand.trim(),
      itemForm: itemForm.trim(),
      price: (price || "").trim(),
      mainImageUrl: normalizedMain,
      additionalImageUrls,
    };
  }, title);
}

/**
 * Gemini OCR extraction
 */
async function geminiExtract(base64Image) {
  const prompt = `
You are given a screenshot of an Amazon product page.
Extract JSON with:
- title
- brand
- itemForm
- price
Return ONLY valid JSON.`;

  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { mimeType: "image/png", data: base64Image } },
  ]);

  let text = result.response.text().trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(text);
  } catch {
    return { error: "Failed to parse Gemini output", raw: text };
  }
}

// ---------- endpoints ----------
app.get("/", (req, res) => {
  res.send("✅ Amazon scraper with Playwright + Gemini OCR is up.");
});

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url param" });

  const width = 1280,
    height = 800;

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

    // If not a product page, return list of links/buttons instead of scraping
    const productLike = await isProductPage(page);
    if (!productLike) {
      const meta = {
        currentUrl: page.url(),
        title: (await page.title().catch(() => "")) || "",
      };
      const { links, buttons, counts } = await extractLinksAndButtons(page);
      return res.json({
        ok: true,
        pageType: "nonProduct",
        meta,
        links,
        buttons,
        counts,
      });
    }

    // Small pause to stabilize above-the-fold
    await sleep(jitter(500, 500));

    // Scrape product data
    const scraped = await scrapeProductData(page);

    ensureAlive(page, "Page closed before screenshot");

    // Screenshot for OCR (with a small retry)
    const buf = await safeScreenshot(page, { type: "png" }, 1);
    const base64 = buf.toString("base64");

    // Gemini OCR
    const geminiData = await geminiExtract(base64);

    res.json({
      ok: true,
      url,
      pageType: "product",
      scrapedData: scraped,
      geminiOCR: geminiData,
      screenshot: base64,
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
