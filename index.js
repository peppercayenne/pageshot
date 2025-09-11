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
 * Scrape product data from DOM and extract hi-res additional images.
 *
 * Strategy:
 * 1. Try `#imgTagWrapperId img` attributes: data-old-hires, data-a-dynamic-image (JSON map).
 * 2. Parse any embedded script containing "colorImages" and prefer hiRes/large/mainUrl.
 * 3. Fallback to thumbnails under #altImages / .imageThumb.
 * 4. Filter out obvious icons/overlays and dedupe.
 */
async function scrapeProductData(page) {
  // helper to normalize & filter URLs in page context
  const data = await page.evaluate(() => {
    const out = {
      title: "",
      brand: "",
      itemForm: "",
      price: "",
      mainImageUrl: "",
      additionalImageUrls: [],
    };

    // text helper
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || "").trim() : "";
    };

    out.title = (text("#productTitle") || text("#title") || "").trim();
    out.brand = (text("#bylineInfo") || "").trim();

    // itemForm
    (function () {
      const li = Array.from(document.querySelectorAll("li")).find((el) =>
        (el.textContent || "").toLowerCase().includes("item form")
      );
      if (li) {
        const parts = (li.textContent || "").split(":");
        if (parts.length > 1) out.itemForm = parts.slice(1).join(":").trim();
      }
    })();

    // price detection
    (function () {
      try {
        const candidates = Array.from(document.querySelectorAll(".a-price .a-offscreen"))
          .map((el) => (el.textContent || "").trim())
          .filter((t) => /^\$?\d/.test(t));
        if (candidates.length) {
          out.price = candidates[0];
          return;
        }
      } catch {}
      out.price = text("#priceblock_ourprice") || text("#priceblock_dealprice") || text("#price_inside_buybox") || "";
      out.price = (out.price || "").trim();
    })();

    // Utilities
    function looksLikeIcon(url) {
      if (!url) return true;
      const low = url.toLowerCase();
      return /icon|overlay|spinner|play-icon|ss40|sprite|blank|transparent/.test(low);
    }

    // Try main image via several attributes
    (function () {
      const mainImg = document.querySelector("#imgTagWrapperId img, #landingImage, img#landingImage, #main-image-container img");
      if (mainImg) {
        // data-old-hires often contains hi-res URL
        const oldHires = mainImg.getAttribute("data-old-hires") || mainImg.getAttribute("data-old-hires");
        if (oldHires && oldHires.trim()) {
          out.mainImageUrl = oldHires.trim();
          return;
        }
        // data-a-dynamic-image is usually JSON mapping url -> [w,h]
        const dyn = mainImg.getAttribute("data-a-dynamic-image");
        if (dyn) {
          try {
            const parsed = JSON.parse(dyn);
            // keys are URLs, values are [w,h]; pick the largest by area
            const keys = Object.keys(parsed);
            if (keys.length) {
              keys.sort((a, b) => {
                const pa = parsed[a] || [0, 0];
                const pb = parsed[b] || [0, 0];
                return (pb[0] * pb[1] || 0) - (pa[0] * pa[1] || 0);
              });
              out.mainImageUrl = keys[0];
              return;
            }
          } catch {}
        }
        // fallback to src
        out.mainImageUrl = mainImg.getAttribute("src") || mainImg.src || "";
      }
    })();

    // Parse any script tag that contains "colorImages" and extract hiRes/large/mainUrl
    (function () {
      const scripts = Array.from(document.scripts || []);
      for (const s of scripts) {
        const t = s.textContent || "";
        if (!t || (t.indexOf("colorImages") === -1 && t.indexOf("colorToAsin") === -1 && t.indexOf("imageBlock") === -1)) continue;

        // find the "colorImages" key and then try to grab the object by brace matching
        const keyIdx = t.indexOf('"colorImages"');
        if (keyIdx === -1) continue;
        const braceStart = t.indexOf("{", keyIdx);
        if (braceStart === -1) continue;

        // simple brace matching to extract the object literal for colorImages
        let depth = 0;
        let i = braceStart;
        for (; i < t.length; i++) {
          if (t[i] === "{") depth++;
          else if (t[i] === "}") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
        }
        const jsonFragment = t.slice(braceStart, i);
        try {
          // wrap it into {"colorImages": <fragment>} so we can parse safely
          const wrapped = `{"colorImages":${jsonFragment}}`;
          const parsed = JSON.parse(wrapped);
          const colorImages = parsed.colorImages;
          if (colorImages && colorImages.initial && Array.isArray(colorImages.initial)) {
            const arr = colorImages.initial;
            const extracted = [];
            for (const it of arr) {
              // prefer hiRes, then large, then mainUrl, then thumbnail if present
              if (it.hiRes) extracted.push(it.hiRes);
              else if (it.large) extracted.push(it.large);
              else if (it.mainUrl) extracted.push(it.mainUrl);
              else if (it.thumbnail) extracted.push(it.thumbnail);
            }
            if (extracted.length) {
              // set main if missing or choose the largest from extracted
              const unique = Array.from(new Set(extracted.filter(Boolean)));
              // try to pick largest by hint in URL (_AC_SL\d+_)
              unique.sort((a, b) => {
                const pa = (a.match(/_AC_SL(\d+)_/) || [0, 0])[1] || 0;
                const pb = (b.match(/_AC_SL(\d+)_/) || [0, 0])[1] || 0;
                return Number(pb) - Number(pa);
              });
              // if mainImageUrl missing or the top extracted looks bigger, prefer it
              if (!out.mainImageUrl) out.mainImageUrl = unique[0] || "";
              // push others into additional list
              for (const u of unique) {
                if (u && u !== out.mainImageUrl) out.additionalImageUrls.push(u);
              }
              // done, prefer colorImages over other parsing
              break;
            }
          }
        } catch (e) {
          // ignore parse errors and continue searching
        }
      }
    })();

    // If we don't yet have additional images, pull from #altImages thumbnails and altImages selectors
    (function () {
      if (out.additionalImageUrls.length === 0) {
        const thumbs = Array.from(document.querySelectorAll("#altImages img, .imageThumbnail img, .imageThumb img, #altImages .a-button-thumbnail img"));
        for (const img of thumbs) {
          const src = img.getAttribute("data-old-hires") || img.getAttribute("data-src") || img.getAttribute("src") || img.src || "";
          if (src) out.additionalImageUrls.push(src);
        }
      }
    })();

    // If still no main but additional exist, pick first additional as main
    if (!out.mainImageUrl && out.additionalImageUrls.length) {
      out.mainImageUrl = out.additionalImageUrls.shift();
    }

    // Normalize, filter icons/overlays, dedupe, remove main from additional
    out.mainImageUrl = (out.mainImageUrl || "").trim();
    let add = out.additionalImageUrls || [];
    add = add.map((u) => (u || "").trim()).filter(Boolean);
    // remove obvious icons/overlay
    add = add.filter((u) => !looksLikeIcon(u));
    // remove duplicates and exclude main
    const set = new Set();
    const cleaned = [];
    for (const u of add) {
      if (!u) continue;
      if (u === out.mainImageUrl) continue;
      if (!set.has(u)) {
        set.add(u);
        cleaned.push(u);
      }
    }
    out.additionalImageUrls = cleaned;

    return out;
  });

  // Final filter & ensure arrays are strings
  data.additionalImageUrls = Array.isArray(data.additionalImageUrls) ? data.additionalImageUrls : [];
  // filter any leftover icons at outer level too
  data.additionalImageUrls = data.additionalImageUrls.filter((u) => {
    if (!u) return false;
    const low = u.toLowerCase();
    if (/icon|overlay|ss40|sprite|play-icon|transparent/.test(low)) return false;
    return true;
  });

  // final dedupe and ensure main not duplicated
  const all = [];
  const seen = new Set();
  if (data.mainImageUrl) {
    seen.add(data.mainImageUrl);
  }
  for (const u of data.additionalImageUrls) {
    if (!seen.has(u)) {
      seen.add(u);
      all.push(u);
    }
  }
  data.additionalImageUrls = all;

  return data;
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

  const width = 1280, height = 800;
  let browser;
  try {
    const { browser: br, page } = await minimalContext(width, height);
    browser = br;

    await page.goto(url, { timeout: 60000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Scraping (DOM)
    const scraped = await scrapeProductData(page);

    // Screenshot for OCR
    const buf = await page.screenshot({ type: "png" });
    const base64 = buf.toString("base64");

    // Gemini OCR
    const geminiData = await geminiExtract(base64);

    await browser.close();
    res.json({
      ok: true,
      url,
      scrapedData: scraped,
      geminiOCR: geminiData,
      screenshot: base64,
    });
  } catch (err) {
    try {
      await browser?.close();
    } catch {}
    res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Running on port ${PORT}`);
});
