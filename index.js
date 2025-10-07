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

  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
  });

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
const isDpUrl = (u = "") => /\/dp\/[A-Z0-9]{8,10}/i.test(u) || /\/gp\/product\/[A-Z0-9]{8,10}/i.test(u);

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
    if (/enter the characters|type the characters|sorry/i.test(bodyText)) {
      return true;
    }
  } catch {}
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

/* -------- Continue Shopping / Side-sheet handling (body + popovers) ------- */
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

async function clickContinueShoppingIfPresent(page) {
  if (await closeAttachSideSheetIfVisible(page)) return true;

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
    // Body-level confirmers seen after add-to-cart
    'button:has-text("Continue shopping")',
    'a:has-text("Continue shopping")',
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

async function handleContinueShopping(page, context, fallbackUrl) {
  try {
    const clicked = await clickContinueShoppingIfPresent(page);
    if (!clicked) return { page, dismissed: false };

    const popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
    const navPromise = page.waitForNavigation({ timeout: 15000, waitUntil: "commit" }).catch(() => null);
    const dclPromise = page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);

    await Promise.race([popupPromise, navPromise, dclPromise]);

    const pages = context.pages();
    const active = pages.find((p) => !p.isClosed() && p.url() !== "about:blank");
    if (active && active !== page) {
      try { await active.bringToFront(); } catch {}
      return { page: active, dismissed: true };
    }

    if (page && !page.isClosed()) return { page, dismissed: true };

    const fresh = await context.newPage();
    try { await fresh.bringToFront(); } catch {}
    if (fallbackUrl) await safeGoto(fresh, fallbackUrl, { retries: 1, timeout: 60000 });
    return { page: fresh, dismissed: true };
  } catch {
    try {
      const adopted = await adoptActivePageOrThrow(page, context);
      return { page: adopted, dismissed: true };
    } catch {
      const fresh = await context.newPage();
      try { await fresh.bringToFront(); } catch {}
      if (fallbackUrl) await safeGoto(fresh, fallbackUrl, { retries: 1, timeout: 60000 });
      return { page: fresh, dismissed: true };
    }
  }
}

/* -------------------------------- Screenshot ------------------------------- */
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

/* --------------------------- Product page heuristic ------------------------ */
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

/* ---------------------------- Non-product extraction ----------------------- */
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

/* ------------------------------- DOM scraping ------------------------------ */
/**
 * Scrape product data (DOM-only fields) + imageSourceCounts
 */
async function scrapeProductData(page) {
  const title =
    (await page.textContent("#productTitle").catch(() => null)) ||
    (await page.textContent("#title").catch(() => null));

  return await page.evaluate((title) => {
    const cleanSpaces = (s) => (s || "").replace(/\s+/g, " ").trim();
    const stripMarks = (s) => (s || "").replace(/[\u200E\u200F\u061C]/g, "");
    const cleanText = (s) => cleanSpaces(stripMarks(s));

    // -------- Item Form --------
    const itemForm = (() => {
      const row =
        document.querySelector("tr.po-item_form") ||
        document.querySelector('tr[class*="po-item_form"]');
      if (row) {
        const tds = row.querySelectorAll("td");
        if (tds.length >= 2) {
          const text = cleanSpaces(tds[1].innerText || tds[1].textContent || "");
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
          const text = cleanSpaces(tds[1].innerText || tds[1].textContent || "");
          if (text) return text;
        }
      }
      const li = Array.from(
        document.querySelectorAll("#detailBullets_feature_div li, li")
      ).find((el) => /item\s*form/i.test(el.innerText || el.textContent || ""));
      if (li) {
        const raw = cleanSpaces(li.innerText || li.textContent || "");
        const m = raw.match(/item\s*form\s*[:\-]?\s*(.+)$/i);
        if (m && m[1]) return cleanSpaces(m[1]);
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
        if (sym) text = sym + text;
        else {
          const iso = document.querySelector('meta[property="og:price:currency"]')?.getAttribute("content") || "";
          if (iso) text = iso + " " + text;
        }
      }
      return text || "";
    };
    const price = getPriceWithCurrency();

    // -------- Featured bullets --------
    const featuredBullets = (() => {
      const items = Array.from(document.querySelectorAll("#feature-bullets ul li"))
        .map((li) => cleanSpaces(li.innerText || li.textContent || ""))
        .filter(Boolean)
        .map((text) => `• ${text} `);
      return items.length ? items.join("") : "";
    })();

    // -------- Product Description --------
    const productDescription = (() => {
      const el = document.querySelector("#productDescription");
      if (!el) return "";
      return cleanSpaces(el.innerText || el.textContent || "");
    })();

    // ========= IMAGES (YOUR EXACT BLOCK) + imageSourceCounts =========
    const mainImageUrl = (() => {
      const imgTag = document.querySelector("#landingImage") || document.querySelector("#imgTagWrapperId img");
      if (imgTag) return imgTag.getAttribute("src") || "";
      return "";
    })();
    const normalizeImageUrl = (url) => (url ? url.replace(/\._[A-Z0-9_,]+\_\.jpg/i, ".jpg") : "");
    const normalizedMain = normalizeImageUrl((mainImageUrl || "").trim());

    // Source 1: visible thumbnails
    let additionalImageUrls = Array.from(document.querySelectorAll("#altImages img, .imageThumb img"))
      .map((img) => img.getAttribute("src") || "")
      .map((src) => (src || "").trim())
      .filter(Boolean);

    // Source 2: landing image attributes
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

    // Source 3: global HTML sweep (hi-res _AC_SL)
    const hiResMatches = Array.from(
      document.documentElement.innerHTML.matchAll(
        /https:\/\/[^"\s]+?\._AC_SL\d+_\.jpg(?:\?[^"\s]*)?/gi
      )
    ).map((m) => m[0]);

    // Track first source for counts BEFORE dedupe/filter (by raw URL)
    const firstSourceByUrl = new Map();
    const markIfFirst = (u, label) => {
      if (!u) return;
      const key = String(u);
      if (!firstSourceByUrl.has(key)) firstSourceByUrl.set(key, label);
    };
    additionalImageUrls.forEach((u) => markIfFirst(u, "visibleThumbs"));
    fromLandingAttrs.forEach((u) => markIfFirst(u, "landingAttrs"));
    hiResMatches.forEach((u) => markIfFirst(u, "htmlSweep"));

    // Merge (your original order: visible → landing → sweep) + dedupe
    additionalImageUrls = [
      ...additionalImageUrls,
      ...fromLandingAttrs.map((u) => (u || "").trim()).filter(Boolean),
      ...hiResMatches,
    ];

    additionalImageUrls = [...new Set(additionalImageUrls)];

    // Remove junk thumbs/sprites/overlays
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

    // Keep only _AC_SL{n}_.jpg and drop the main image (normalized to .jpg) if it matches
    const AC_ANY = /\._AC_SL\d+_\.jpg(?:\?.*)?$/i;
    additionalImageUrls = additionalImageUrls
      .filter((url) => url && url !== normalizedMain)
      .filter((url) => AC_ANY.test(url));

    // Final de-dupe after filters
    additionalImageUrls = [...new Set(additionalImageUrls)];

    // imageSourceCounts: count by FIRST source for the final kept URLs
    const imageSourceCounts = { visibleThumbs: 0, landingAttrs: 0, htmlSweep: 0 };
    for (const u of additionalImageUrls) {
      const label = firstSourceByUrl.get(u);
      if (label === "visibleThumbs") imageSourceCounts.visibleThumbs++;
      else if (label === "landingAttrs") imageSourceCounts.landingAttrs++;
      else if (label === "htmlSweep") imageSourceCounts.htmlSweep++;
    }
    // ========= END IMAGES =========

    // -------- Reviews count --------
    const reviewCount = (() => {
      const el = document.querySelector("#acrCustomerReviewText");
      if (!el) return "";
      const raw = cleanText(el.innerText || el.textContent || "");
      const digits = (raw.match(/\d/g) || []).join("");
      return digits || "";
    })();

    // -------- Rating (stars) --------
    const rating = (() => {
      const el = document.querySelector("#acrPopover");
      const t = el?.getAttribute("title") || el?.getAttribute("aria-label") || "";
      if (!t) return "";
      return cleanSpaces(t.replace(/out of 5 stars/i, ""));
    })();

    // -------- Date First Available (with fallback to Release date) --------
    const looksLikeDate = (s) =>
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b\s+\d{1,2},\s*\d{4}/i.test(
        s || ""
      );
    const stripLeadingLabel = (s) =>
      cleanText((s || "").replace(/^date\s*first\s*available\s*[:\-–—]?\s*/i, ""));
    const normLabel = (s) => cleanText(String(s || "").toLowerCase().replace(/[:\-–—]+/g, " "));
    const dateFirstAvailable = (() => {
      const nextSpanValue = (labelSpan) => {
        if (!labelSpan) return "";
        let sib = labelSpan.nextElementSibling;
        while (sib) {
          const txt = stripLeadingLabel(cleanText(sib.innerText || sib.textContent || ""));
          if (txt) return txt;
          sib = sib.nextElementSibling;
        }
        const parent = labelSpan.parentElement;
        if (parent) {
          const candidates = Array.from(parent.querySelectorAll("span"))
            .filter((s) => !/a-text-bold/.test(s.className || ""));
          for (const c of candidates) {
            const val = stripLeadingLabel(cleanText(c.innerText || c.textContent || ""));
            if (val) return val;
          }
        }
        return "";
      };

      const container = document.querySelector("#detailBullets_feature_div");
      if (container) {
        const bolds = Array.from(container.querySelectorAll("span.a-text-bold"));
        for (const b of bolds) {
          const label = normLabel(b.innerText || b.textContent || "");
          if (/^date\s*first\s*available\b/i.test(label)) {
            const val = nextSpanValue(b);
            if (val && looksLikeDate(val)) return val;
          }
        }
        const li = Array.from(container.querySelectorAll("li")).find((el) =>
          /date\s*first\s*available/i.test(el.innerText || el.textContent || "")
        );
        if (li) {
          const spans = Array.from(li.querySelectorAll("span"));
          for (const s of spans) {
            const txt = stripLeadingLabel(cleanText(s.innerText || s.textContent || ""));
            if (txt && looksLikeDate(txt)) return txt;
          }
          const raw = stripLeadingLabel(cleanText(li.innerText || li.textContent || ""));
          if (looksLikeDate(raw)) return raw;
        }
      }

      const detailsRoots = [
        document.querySelector("#prodDetails"),
        document.querySelector("#productDetails_detailBullets_sections1"),
        document.querySelector("#productDetails_techSpec_section_1"),
        document.querySelector("#productDetails_techSpec_section_2"),
      ].filter(Boolean);

      const isReleaseLabel = (txt) => {
        const n = normLabel(txt);
        return (
          /\brelease\s*date\b/i.test(n) ||
          /\breleased\s*date\b/i.test(n) ||
          /\bdate\s*released\b/i.test(n) ||
          /\bdate\s*of\s*release\b/i.test(n)
        );
      };
      const isFirstAvailLabel = (txt) => /^date\s*first\s*available\b/i.test(normLabel(txt));

      for (const root of detailsRoots) {
        const rows = Array.from(root.querySelectorAll("tr"));
        for (const tr of rows) {
          const th = tr.querySelector("th");
          const td = tr.querySelector("td");
          if (!th || !td) continue;

          const thText = cleanText(th.innerText || th.textContent || "");
          const tdText = cleanText(td.innerText || td.textContent || "");
          if (!tdText) continue;

          if (isFirstAvailLabel(thText)) return tdText;
          if (isReleaseLabel(thText)) return tdText; // fallback
        }
      }

      const generic = Array.from(document.querySelectorAll("#prodDetails th, #prodDetails td, th, td, dt, dd"));
      for (let i = 0; i < generic.length - 1; i++) {
        const label = cleanText(generic[i].innerText || generic[i].textContent || "");
        const value = cleanText(generic[i + 1].innerText || generic[i + 1].textContent || "");
        if (!value) continue;
        if (isFirstAvailLabel(label)) return stripLeadingLabel(value);
        if (looksLikeDate(value) && /available|release/i.test(label)) return stripLeadingLabel(value);
      }
      return "";
    })();

    return {
      title: (title || "").trim(),
      itemForm: (itemForm || "").trim(),
      price: (price || "").trim(),
      featuredBullets: (featuredBullets || "").trim(),
      productDescription: (productDescription || "").trim(),
      mainImageUrl: normalizedMain || "",
      additionalImageUrls,
      imageSourceCounts, // counts per source for the final kept images
      reviewCount,
      rating,
      dateFirstAvailable,
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

/**
 * Detour recognizer: pages that are NOT products
 */
function isDetourUrl(u = "") {
  if (!u) return false;
  if (isDpUrl(u)) return false; // /dp/... or /gp/product/... are NOT detours
  return (
    /\/hz\/mobile/i.test(u) ||
    /\/ap\/signin/i.test(u) ||
    /\/gp\/help/i.test(u) ||
    /\/gp\/navigation/i.test(u) ||
    /\/customer-preferences/i.test(u) ||
    /\/gp\/yourstore/i.test(u) ||
    /\/gp\/history/i.test(u)
  );
}

app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ ok: false, error: "Missing url param" });

  const width = 1280, height = 800;
  let browser, context, page;

  // Counters/metrics
  let detourBounceAttempts = 0;
  let continueShoppingDismissals = 0;

  try {
    const ctx = await minimalContext(width, height);
    browser = ctx.browser;
    context = ctx.context;
    page = ctx.page;

    // 1) First navigation
    await safeGoto(page, targetUrl, { retries: 2, timeout: 60000 });
    ensureAlive(page, "Page unexpectedly closed after navigation");

    // 2) Detour-bounce loop (max 3). Small delay before checking, to allow redirects to settle.
    for (let i = 0; i < 3; i++) {
      await sleep(jitter(250, 350));
      const cur = page.url();
      if (!isDetourUrl(cur)) break;

      detourBounceAttempts++;
      await safeGoto(page, targetUrl, { retries: 1, timeout: 60000 });
      await sleep(jitter(250, 350));
    }

    // 3) Continue-shopping handling up to 3 dismissals until product looks ready
    for (let i = 0; i < 3; i++) {
      const { page: p2, dismissed } = await handleContinueShopping(page, context, targetUrl);
      page = p2;
      if (dismissed) continueShoppingDismissals++;
      const ready = await isProductPage(page);
      if (ready) break;
      await sleep(jitter(200, 300));
    }

    // 4) Product vs non-product final check
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

    // 4a) NON-PRODUCT → return minimal info + screenshot + metrics
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
        detourBounceAttempts,              // debugging
        continueShoppingDismissals,        // number of times we clicked/dismissed
        screenshot: base64NP,
        meta,
        links,
        buttons,
        counts,
      });
    }

    // 5) PRODUCT PAGE: scrape DOM, take screenshot, OCR
    await sleep(jitter(300, 400)); // stabilize
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

    const gemini = await geminiExtract(base64);
    const priceGemini = normalizeGeminiPrice(gemini.price, scraped.price);

    const resolvedUrl = page.url() || targetUrl;
    const asinResolved = extractASINFromUrl(resolvedUrl) || extractASINFromUrl(targetUrl);

    // FINAL JSON (imageSourceCounts included)
    res.json({
      ok: true,
      url: resolvedUrl,
      pageType: "product",
      detourBounceAttempts,
      continueShoppingDismissals,
      ASIN: asinResolved || "Unspecified",
      title: scraped.title || "Unspecified",
      brand: gemini.brand || "Unspecified",
      itemForm: scraped.itemForm || "Unspecified",
      price: scraped.price || "Unspecified",
      priceGemini: priceGemini || "Unspecified",
      featuredBullets: scraped.featuredBullets || "Unspecified",
      productDescription: scraped.productDescription || "Unspecified",
      mainImageUrl: scraped.mainImageUrl || "Unspecified",
      additionalImageUrls: scraped.additionalImageUrls || [],
      imageSourceCounts: scraped.imageSourceCounts || { visibleThumbs: 0, landingAttrs: 0, htmlSweep: 0 },
      reviewCount: scraped.reviewCount || "Unspecified",
      rating: scraped.rating || "Unspecified",
      dateFirstAvailable: scraped.dateFirstAvailable || "Unspecified",
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

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Running on port ${PORT}`);
});
