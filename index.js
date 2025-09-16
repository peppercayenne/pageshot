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

  return { browser, page };
}

/**
 * Simple helpers
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

function isRobotCheckUrl(url) {
  if (!url) return false;
  return (
    url.includes("/errors/validateCaptcha") ||
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
  } catch {
    // if any of those throw, treat as not blocked (we'll fail elsewhere)
  }
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
      // Slight random delay before navigating to reduce burst patterns
      await sleep(jitter(250, 500));

      await page.goto(url, { timeout, waitUntil: "commit" });

      // Give the DOM a moment to render initial HTML
      await sleep(jitter(700, 600));

      // Block/robot check detection
      if (await looksBlocked(page)) {
        throw new Error("Blocked by Amazon CAPTCHA/anti-bot");
      }

      return; // success
    } catch (err) {
      lastErr = err;
      // If page got closed for any reason, don't reuse it
      if (page.isClosed()) throw lastErr;

      // Backoff before retrying (1s..2.5s jitter)
      if (attempt < retries) {
        await sleep(jitter(1000, 1500));
      }
      attempt++;
    }
  }
  throw lastErr || new Error("Navigation failed");
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
      const imgTag = document.querySelector("#imgTagWrapperId img");
      if (imgTag) return imgTag.getAttribute("src") || "";
      return "";
    })();

    // Normalize thumbnail -> base jpg (do not force AC_SL here)
    const normalizeImageUrl = (url) => {
      if (!url) return "";
      return url.replace(/\._[A-Z0-9_,]+\_\.jpg/i, ".jpg");
    };

    const normalizedMain = normalizeImageUrl((mainImageUrl || "").trim());

    let additionalImageUrls = Array.from(
      document.querySelectorAll("#altImages img, .imageThumb img")
    )
      .map((img) => img.getAttribute("src") || "")
      .map((src) => normalizeImageUrl(src))
      .filter((src) => {
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

    // 🔍 Scan entire document for hi-res URLs ending with ._AC_SL1500_.jpg (allow optional query)
    const hiResMatches = Array.from(
      document.documentElement.innerHTML.matchAll(
        /https:\/\/[^"]+?\._AC_SL1500_\.jpg(?:\?[^"]*)?/gi
      )
    ).map((m) => m[0]);

    // Merge, dedupe
    additionalImageUrls = [...new Set([...additionalImageUrls, ...hiResMatches])];

    // Final pass:
    // 1) Remove main image if present
    // 2) STRICTLY keep only AC_SL1500 images (handles optional query strings)
    const AC1500 = /\._AC_SL1500_\.jpg(?:\?.*)?$/i;
    additionalImageUrls = additionalImageUrls
      .filter((url) => url && url !== normalizedMain)
      .filter((url) => AC1500.test(url));

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

  let browser;
  let page;
  try {
    const ctx = await minimalContext(width, height);
    browser = ctx.browser;
    page = ctx.page;

    // Hardened navigation with retry + CAPTCHA detection
    await safeGoto(page, url, { retries: 2, timeout: 60000 });

    // One small, bounded wait to let above-the-fold content stabilize
    await sleep(jitter(500, 500));

    // Scraping
    const scraped = await scrapeProductData(page);

    // Screenshot for OCR
    const buf = await page.screenshot({ type: "png" });
    const base64 = buf.toString("base64");

    // Gemini OCR
    const geminiData = await geminiExtract(base64);

    res.json({
      ok: true,
      url,
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
    // Always try to close, ignoring errors
    try {
      if (page && !page.isClosed()) await page.close({ runBeforeUnload: false });
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
