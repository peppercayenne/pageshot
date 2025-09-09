// index.js
// Express + Playwright + Gemini OCR
// Scrapes Amazon product data with DOM + OCR
//
// GET /scrape?url=...
//
// Env:
//   PORT=8080
//   GEMINI_API_KEY=your_gemini_api_key

import express from "express";
import { chromium } from "playwright";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ---------- minimal context ----------
async function minimalContext(chromium, width, height) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
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

async function isVisible(pageOrFrame, selector) {
  const el = await pageOrFrame.$(selector);
  if (!el) return false;
  return el.isVisible();
}

async function detectCase(page) {
  const html = await page.content();
  const is503 = /503 - Service Unavailable/i.test(html);
  const is504 = /504 - Gateway Time-out/i.test(html);

  const titleVisible = await isVisible(page, "#productTitle");
  if (titleVisible) {
    return { type: "normal", signals: { titleVisible: true } };
  }

  if (is503) return { type: "error", errorType: "503", signals: { is503 } };
  if (is504) return { type: "error", errorType: "504", signals: { is504 } };

  return { type: "normal", signals: { fallbackNormal: true } };
}

async function getTitle(page) {
  const title =
    (await page.textContent("#productTitle").catch(() => null)) ||
    (await page.textContent("#title").catch(() => null)) ||
    (await page.evaluate(() => {
      const el = document.querySelector('meta[property="og:title"]');
      return el ? el.getAttribute("content") : null;
    }).catch(() => null)) ||
    (await page.title().catch(() => null));
  return (title || "").trim();
}

async function scrapeProductData(page) {
  return await page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || "").trim() : "";
    };

    const brand = (() => {
      const tr = document.querySelector("tr.a-spacing-small.po-brand");
      if (tr) {
        const tds = tr.querySelectorAll("td");
        if (tds[1]) return (tds[1].textContent || "").trim();
      }
      const byline = document.querySelector("#bylineInfo");
      if (byline) return (byline.textContent || "").trim();
      return "";
    })();

    const itemForm = (() => {
      const tr = document.querySelector("tr.a-spacing-small.po-item_form");
      if (tr) {
        const tds = tr.querySelectorAll("td");
        if (tds[1]) return (tds[1].textContent || "").trim();
      }
      return "";
    })();

    let price = "";
    try {
      const candidates = Array.from(
        document.querySelectorAll(".a-price .a-offscreen")
      )
        .map((el) => (el.textContent || "").trim())
        .filter((t) => /^\$?\d/.test(t));
      if (candidates.length) {
        price = candidates[0];
      }
    } catch {}
    if (!price) {
      price =
        text("#priceblock_ourprice") ||
        text("#priceblock_dealprice") ||
        text("#price_inside_buybox") ||
        "";
    }

    const mainImageUrl = (() => {
      const landing = document.querySelector("#landingImage");
      if (landing) {
        return (
          landing.getAttribute("data-old-hires") ||
          landing.getAttribute("src") ||
          ""
        );
      }
      return "";
    })();

    return {
      brand: (brand || "").replace(/\s+/g, " ").trim(),
      itemForm: (itemForm || "").replace(/\s+/g, " ").trim(),
      price: (price || "").replace(/\s+/g, " ").trim(),
      mainImageUrl: (mainImageUrl || "").trim(),
    };
  });
}

// ---------- endpoints ----------
app.get("/", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send("✅ Amazon scraper with Playwright + Gemini OCR is up.");
});

app.get("/scrape", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url parameter" });

  const width = 1280, height = 800;
  const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.set("x-trace-id", traceId);

  let browser;
  try {
    const { browser: br, page } = await minimalContext(chromium, width, height);
    browser = br;

    const navResp = await page.goto(url, {
      timeout: 60000,
      waitUntil: "domcontentloaded",
    });
    const httpStatus = navResp?.status?.() ?? null;

    const detected = await detectCase(page);

    if (detected.type === "error") {
      const buf = await page.screenshot({ type: "png" });
      await browser.close();
      return res.json({
        ok: false,
        _traceId: traceId,
        url,
        httpStatus,
        case: "error",
        errorType: detected.errorType,
        detectorSignals: detected.signals || {},
        base64: buf.toString("base64"),
      });
    }

    const [title, pdata] = await Promise.all([
      getTitle(page),
      scrapeProductData(page),
    ]);
    const buf = await page.screenshot({ type: "png" });
    const base64Image = buf.toString("base64");

    // ---------- Gemini OCR step ----------
    const prompt = `
You are given a screenshot of an Amazon product page.
Extract JSON with fields:
- title
- brand
- itemForm
- price
Return ONLY valid JSON.
`;

    let geminiJson = { error: "Gemini not called" };
    try {
      const result = await model.generateContent([
        { text: prompt },
        { inlineData: { mimeType: "image/png", data: base64Image } },
      ]);

      let geminiText = result.response.text().trim();
      geminiText = geminiText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();

      try {
        geminiJson = JSON.parse(geminiText);
      } catch (e) {
        geminiJson = { error: "Failed to parse Gemini output", raw: geminiText };
      }
    } catch (e) {
      geminiJson = { error: "Gemini call failed", message: e.message };
    }

    await browser.close();

    return res.json({
      ok: true,
      _traceId: traceId,
      url,
      case: "normal",
      playwrightData: {
        title,
        brand: pdata.brand || "",
        itemForm: pdata.itemForm || "",
        price: pdata.price || "",
        mainImageUrl: pdata.mainImageUrl || "",
      },
      geminiData: geminiJson,
      detectorSignals: detected.signals || {},
      base64: base64Image,
    });
  } catch (err) {
    try {
      await browser?.close();
    } catch {}
    return res.status(500).json({
      ok: false,
      _traceId: traceId,
      url,
      case: "error",
      errorType: "exception",
      error: err.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Scraper + Gemini OCR API running on port ${PORT}`);
});
