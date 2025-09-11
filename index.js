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
 * Scrape product data from DOM
 */
async function scrapeProductData(page) {
  function toHiRes(url) {
    if (!url) return "";
    if (/_AC_SL\d+_/.test(url)) return url; // already hi-res
    return url.replace(/(\.[a-z]{3,4})(\?.*)?$/i, "_AC_SL1500_$1");
  }

  const title =
    (await page.textContent("#productTitle").catch(() => null)) ||
    (await page.textContent("#title").catch(() => null));

  return await page.evaluate(({ title, toHiResStr }) => {
    const toHiRes = new Function("url", `return (${toHiResStr})(url);`);

    const brand = (() => {
      const byline = document.querySelector("#bylineInfo");
      return byline ? byline.textContent.trim() : "";
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

    // Main image
    const mainImageEl = document.querySelector("#imgTagWrapperId img");
    let mainImageUrl = "";
    if (mainImageEl) {
      const data = mainImageEl.getAttribute("data-a-dynamic-image");
      if (data) {
        try {
          const parsed = JSON.parse(data);
          mainImageUrl = Object.keys(parsed).sort(
            (a, b) =>
              parsed[b][0] * parsed[b][1] - parsed[a][0] * parsed[a][1]
          )[0];
        } catch {}
      }
      if (!mainImageUrl) mainImageUrl = mainImageEl.src || "";
    }
    mainImageUrl = toHiRes(mainImageUrl);

    // Additional images
    let additionalImageUrls = [];
    const imageBlock = document.getElementById("imageBlockATF");
    if (imageBlock) {
      const scripts = imageBlock.querySelectorAll("script");
      scripts.forEach((s) => {
        const text = s.textContent || "";
        if (text.includes("colorImages")) {
          try {
            const match = text.match(/"colorImages"\s*:\s*{[\s\S]*?}\s*,/);
            if (match) {
              const jsonText = "{" + match[0].slice(0, -1) + "}";
              const parsed = JSON.parse(jsonText);
              if (parsed.colorImages && parsed.colorImages.initial) {
                additionalImageUrls = parsed.colorImages.initial
                  .map((img) => img.hiRes || img.large || img.mainUrl)
                  .filter(Boolean);
              }
            }
          } catch {}
        }
      });
    }

    if (!additionalImageUrls.length) {
      additionalImageUrls = Array.from(
        document.querySelectorAll("#altImages img, .imageThumb img")
      )
        .map((img) => img.src || "")
        .filter(Boolean);
    }

    // Deduplicate and normalize to hi-res
    additionalImageUrls = [...new Set(additionalImageUrls)]
      .map(toHiRes)
      .filter(
        (url) =>
          url &&
          url !== mainImageUrl &&
          !url.includes("icon") &&
          !url.includes("overlay")
      );

    return {
      title: (title || "").trim(),
      brand: brand.trim(),
      itemForm: itemForm.trim(),
      price: (price || "").trim(),
      mainImageUrl,
      additionalImageUrls,
    };
  }, { title, toHiResStr: toHiRes.toString() });
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
  try {
    const { browser: br, page } = await minimalContext(width, height);
    browser = br;

    await page.goto(url, { timeout: 60000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Scraping
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
