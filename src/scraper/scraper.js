import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

/**
 * Improved Clinic Website Scraper
 * - Better content extraction
 * - Price table parsing
 * - Improved text cleaning
 */

const IGNORE_PATTERNS = [
  /blog/i, /news/i, /article/i, /nunews/i,
  /admin/i, /login/i, /signup/i, /register/i,
  /privacy/i, /terms/i, /cookie/i, /gdpr/i,
  /cart/i, /checkout/i, /payment/i,
  /\.pdf$/i, /\.jpg$/i, /\.png$/i, /\.gif$/i,
  /mailto:/i, /tel:/i, /javascript:/i,
  /#$/
];

const PRIORITY_PATTERNS = [
  /cennik/i, /price/i, /ceny/i,
  /sluzby/i, /service/i, /treatment/i,
  /kontakt/i, /contact/i,
  /o-nas/i, /about/i, /team/i,
  /ordinacne/i, /hour/i, /open/i,
  // Product/model pages for dealerships, e-commerce
  /models/i, /product/i, /vozidl/i,
  /sedan/i, /suv/i, /coupe/i, /kombi/i, /hatchback/i,
  /electric/i, /hybrid/i, /overview/i
];

function shouldIgnoreUrl(url) {
  return IGNORE_PATTERNS.some(pattern => pattern.test(url));
}

function isSameDomain(baseUrl, targetUrl) {
  try {
    const base = new URL(baseUrl);
    const target = new URL(targetUrl, baseUrl);
    return base.hostname === target.hostname;
  } catch {
    return false;
  }
}

function normalizeUrl(url, baseUrl) {
  try {
    const normalized = new URL(url, baseUrl);
    normalized.hash = '';
    // Remove tracking params
    ['gad_source', 'gad_campaignid', 'gbraid', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign'].forEach(param => {
      normalized.searchParams.delete(param);
    });
    return normalized.href;
  } catch {
    return null;
  }
}

function extractCleanText($, selector = 'body') {
  const $el = $(selector).clone();
  $el.find('script, style, nav, noscript, svg, iframe').remove();
  $el.find('[class*="cookie"], [class*="popup"], [class*="modal"]').remove();

  return $el.text()
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

/**
 * Extract price tables - specifically for clinic pricing pages
 */
function extractPriceTables($) {
  const prices = [];

  // Look for table structures
  $('table tr, .price-item, .cennik-item, [class*="price"], [class*="cennik"]').each((_, el) => {
    const $row = $(el);
    const text = $row.text().replace(/\s+/g, ' ').trim();

    // Look for price patterns: number followed by € or EUR or Kč
    const priceMatch = text.match(/(\d+(?:[\s,]\d{3})*(?:[.,]\d+)?)\s*(?:€|EUR|Kč|CZK)/i);
    if (priceMatch) {
      prices.push({
        text: text.slice(0, 200),
        price: priceMatch[0]
      });
    }
  });

  // Also scan for inline price mentions
  const bodyText = $('main, article, .content, #content, body').text();
  const priceRegex = /([A-ZÁ-Ža-zá-ž\s\-–]+)[\s:–-]+(\d+(?:[\s,]\d{3})*(?:[.,]\d+)?)\s*(?:€|EUR|Kč|CZK)/gi;
  let match;
  while ((match = priceRegex.exec(bodyText)) !== null) {
    const serviceName = match[1].trim();
    if (serviceName.length > 3 && serviceName.length < 100) {
      prices.push({
        text: `${serviceName}: ${match[2]}€`,
        price: `${match[2]}€`,
        service: serviceName
      });
    }
  }

  return prices;
}

/**
 * Extract structured content from page
 */
function extractPageData($, url) {
  const title = $('title').text().trim();
  const h1 = $('h1').first().text().trim();

  // Get main content
  const mainContent = extractCleanText($, 'main, article, .content, #content')
    || extractCleanText($, 'body');

  // Extract prices
  const prices = extractPriceTables($);

  // Extract contact info
  const pageText = $('body').text();
  const phones = [...new Set((pageText.match(/(?:\+421|0)\s*\d{3}\s*\d{3}\s*\d{3}/g) || []))];
  const emails = [...new Set((pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []))];

  // Opening hours patterns (Slovak)
  const hoursPatterns = [
    /(?:pondelok|utorok|streda|štvrtok|piatok|sobota|nedeľa|po|ut|st|št|pi|so|ne)[:\s\-]*\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}/gi,
    /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)[:\s\-]*\d{1,2}[:.]\d{2}\s*(?:am|pm)?\s*[-–]\s*\d{1,2}[:.]\d{2}\s*(?:am|pm)?/gi
  ];

  const hours = [];
  hoursPatterns.forEach(pattern => {
    const matches = pageText.match(pattern);
    if (matches) hours.push(...matches);
  });

  return {
    url,
    title,
    h1,
    content: mainContent.slice(0, 15000),
    prices,
    phones,
    emails,
    hours: [...new Set(hours)],
    meta: {
      description: $('meta[name="description"]').attr('content') || ''
    }
  };
}

async function scrapeSinglePage(context, url, cleanStartUrl, navTimeoutMs, renderWaitMs) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now();
    const page = await context.newPage();
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: attempt === 1 ? navTimeoutMs : navTimeoutMs * 2
      });
      const navMs = Date.now() - startedAt;
      await page.waitForTimeout(renderWaitMs);

      const html = await page.content();
      const $ = cheerio.load(html);
      const pageData = extractPageData($, url);
      const totalMs = Date.now() - startedAt;
      console.log(`    ✓ ${url.slice(0, 70)} (${navMs}ms nav, ${totalMs}ms total${attempt === 2 ? ', retry' : ''})`);

      // Extract links for next depth
      const links = $('a[href]')
        .map((_, el) => $(el).attr('href'))
        .get()
        .map(href => normalizeUrl(href, url))
        .filter(href => href && isSameDomain(cleanStartUrl, href));

      return { pageData, links };
    } catch (error) {
      const isTimeout = error && (error.name === 'TimeoutError' || /Timeout/i.test(error.message));
      console.error(`  Error: ${url.slice(0, 60)}... - ${error.message}${attempt === 1 && isTimeout ? ' (retrying)' : ''}`);
      if (!(attempt === 1 && isTimeout)) {
        return null;
      }
    } finally {
      await page.close();
    }
  }
  return null;
}

export async function scrapeClinicWebsite(startUrl, maxDepth = 10, maxPages = 25) {
  const cleanStartUrl = normalizeUrl(startUrl, startUrl);
  const CONCURRENCY = Number(process.env.SCRAPER_CONCURRENCY) || 5; // Scrape N pages at once
  const NAV_TIMEOUT_MS = Number(process.env.SCRAPER_NAV_TIMEOUT_MS) || 7000;
  const RENDER_WAIT_MS = Number(process.env.SCRAPER_RENDER_WAIT_MS) || 150;
  const MAX_PAGES = Number(process.env.SCRAPER_MAX_PAGES) || maxPages;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1280, height: 720 }
  });

  // Skip heavy assets and trackers to speed up navigation
  await context.route('**/*', route => {
    const request = route.request();
    const type = request.resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    if (/google-analytics\.com|doubleclick\.net|facebook\.com|hotjar\.com/i.test(request.url())) {
      return route.abort();
    }
    return route.continue();
  });

  const visited = new Set();
  const scrapedPages = [];
  let currentDepthUrls = [cleanStartUrl];

  console.log(`Starting scrape: ${cleanStartUrl}`);

  try {
    for (let depth = 0; depth <= maxDepth && scrapedPages.length < MAX_PAGES; depth++) {
      const urlsToScrape = currentDepthUrls
        .filter(url => {
          const normalized = normalizeUrl(url, cleanStartUrl);
          if (!normalized || visited.has(normalized) || shouldIgnoreUrl(normalized)) return false;
          visited.add(normalized);
          return true;
        })
        .slice(0, MAX_PAGES - scrapedPages.length);

      if (urlsToScrape.length === 0) break;

      console.log(`  [depth ${depth}] Scraping ${urlsToScrape.length} pages...`);

      const nextDepthLinks = [];

      // Process in batches of CONCURRENCY
      for (let i = 0; i < urlsToScrape.length; i += CONCURRENCY) {
        const batch = urlsToScrape.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(url => scrapeSinglePage(context, url, cleanStartUrl, NAV_TIMEOUT_MS, RENDER_WAIT_MS))
        );

        results.forEach(result => {
          if (result) {
            scrapedPages.push(result.pageData);
            if (depth < maxDepth) {
              nextDepthLinks.push(...result.links);
            }
          }
        });
      }

      // Prioritize and dedupe links for next depth
      const uniqueLinks = [...new Set(nextDepthLinks)].filter(url => !visited.has(url));
      currentDepthUrls = uniqueLinks.sort((a, b) => {
        const aPriority = PRIORITY_PATTERNS.some(p => p.test(a)) ? 1 : 0;
        const bPriority = PRIORITY_PATTERNS.some(p => p.test(b)) ? 1 : 0;
        return bPriority - aPriority;
      });
    }
  } finally {
    await browser.close();
  }

  console.log(`Scraping complete: ${scrapedPages.length} pages`);

  return scrapedPages;
}
