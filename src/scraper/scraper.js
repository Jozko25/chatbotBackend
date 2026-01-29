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
  // Team/people pages in various languages
  /ludia/i, /tym/i, /personal/i, /zamestnanci/i, /lekari/i, /lekar/i,
  /doktori/i, /odbornici/i, /specialisti/i, /nas-tym/i, /nasi-lekari/i,
  /doctors/i, /staff/i, /our-team/i, /meet-the-team/i, /practitioners/i,
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

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (XeloChatBot/1.0)'
      }
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseSitemapXml(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = $('url > loc')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  const sitemaps = $('sitemap > loc')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  return { urls, sitemaps };
}

async function discoverSitemapUrls(startUrl) {
  const base = new URL(startUrl);
  const sitemapCandidates = new Set();

  const robotsUrl = new URL('/robots.txt', base).href;
  const robotsTxt = await fetchText(robotsUrl);
  if (robotsTxt) {
    robotsTxt.split('\n').forEach(line => {
      const match = line.match(/^\s*Sitemap:\s*(.+)\s*$/i);
      if (match && match[1]) sitemapCandidates.add(match[1].trim());
    });
  }

  if (sitemapCandidates.size === 0) {
    sitemapCandidates.add(new URL('/sitemap.xml', base).href);
    sitemapCandidates.add(new URL('/sitemap_index.xml', base).href);
  }

  const discovered = new Set();
  const toFetch = [...sitemapCandidates];

  while (toFetch.length > 0 && discovered.size < 500) {
    const sitemapUrl = toFetch.shift();
    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;

    const { urls, sitemaps } = parseSitemapXml(xml);

    urls.forEach(loc => discovered.add(loc));
    sitemaps.forEach(loc => {
      if (!sitemapCandidates.has(loc)) {
        sitemapCandidates.add(loc);
        toFetch.push(loc);
      }
    });
  }

  return [...discovered]
    .map(url => normalizeUrl(url, startUrl))
    .filter(url => url && isSameDomain(startUrl, url) && !shouldIgnoreUrl(url));
}

function extractCleanText($, selector = 'body') {
  const $el = $(selector).clone();

  // Remove non-content elements
  $el.find('script, style, noscript, svg, iframe, header nav, footer nav').remove();
  $el.find('[class*="cookie"], [class*="popup"], [class*="modal"], [class*="banner"], [aria-hidden="true"]').remove();
  $el.find('[role="navigation"], [role="banner"]').remove();

  // For Next.js apps, also look in specific containers
  // Next.js often wraps content in #__next or main

  let text = $el.text();

  // Clean up whitespace but preserve some structure
  text = text
    .replace(/\t+/g, ' ')           // tabs to space
    .replace(/ +/g, ' ')            // multiple spaces to single
    .replace(/\n +/g, '\n')         // space after newline
    .replace(/ +\n/g, '\n')         // space before newline
    .replace(/\n{3,}/g, '\n\n')     // max 2 newlines
    .trim();

  return text;
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

  // Try multiple content selectors, pick the one with most content
  // This handles Next.js (#__next), React roots, and traditional layouts
  const contentSelectors = [
    '#__next main',           // Next.js with main inside
    '#__next',                // Next.js root
    '#root main',             // React with main
    '#root',                  // React root
    'main',                   // Standard HTML5
    'article',                // Article pages
    '[role="main"]',          // ARIA main
    '.content',               // Common class
    '#content',               // Common ID
    '.page-content',          // Common class
    '.main-content',          // Common class
    'body'                    // Fallback
  ];

  let mainContent = '';
  for (const selector of contentSelectors) {
    if ($(selector).length > 0) {
      const content = extractCleanText($, selector);
      // Use this content if it's longer than what we have
      if (content.length > mainContent.length) {
        mainContent = content;
      }
      // If we found good content (>500 chars) in a specific selector, use it
      if (content.length > 500 && selector !== 'body') {
        mainContent = content;
        break;
      }
    }
  }

  // If still no content, try body
  if (mainContent.length < 100) {
    mainContent = extractCleanText($, 'body');
  }

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
    content: mainContent.slice(0, 50000), // Increased to capture more content per page
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
      // Use networkidle for SPAs (Next.js, React, etc.) - waits for network to be idle
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: attempt === 1 ? navTimeoutMs : navTimeoutMs * 2
      });
      const navMs = Date.now() - startedAt;

      // Wait for content to render - important for Next.js/React
      await page.waitForTimeout(renderWaitMs);

      // Additional wait for any lazy-loaded content or hydration
      // Wait for body to have meaningful content
      try {
        await page.waitForFunction(() => {
          const body = document.body;
          const text = body?.innerText || '';
          // Wait until we have at least 100 characters of content
          return text.length > 100;
        }, { timeout: 3000 });
      } catch {
        // Continue anyway if this times out
      }

      // Handle carousels/sliders - click through and ACCUMULATE all content
      // This is critical for team pages where doctors are in a carousel
      let carouselContent = '';
      try {
        carouselContent = await page.evaluate(async () => {
          const collectedContent = new Set(); // Use Set to avoid duplicates

          // Common carousel selectors for next/arrow buttons
          const carouselNextSelectors = [
            '.swiper-button-next',
            '.slick-next',
            '.carousel-next',
            '.owl-next',
            '.splide__arrow--next',
            '[class*="swiper"][class*="next"]',
            '[class*="slider"][class*="next"]',
            '[class*="carousel"][class*="next"]',
            'button[aria-label*="next" i]',
            'button[aria-label*="Next"]',
            '[class*="arrow-right"]',
            '[class*="arrow"][class*="next"]',
            // SVG arrows often used as next buttons
            'svg[class*="next"]',
            'svg[class*="right"]'
          ];

          // Pagination dot selectors - click each dot to load that slide
          const paginationSelectors = [
            '.swiper-pagination-bullet',
            '.slick-dots button',
            '.slick-dots li',
            '.carousel-indicators button',
            '.carousel-indicators li',
            '.owl-dots button',
            '.owl-dot',
            '.splide__pagination button',
            '[class*="pagination"] button',
            '[class*="pagination"] [class*="dot"]',
            '[class*="dots"] button',
            '[class*="indicator"]'
          ];

          // Common carousel container selectors
          const carouselContainerSelectors = [
            '.swiper-wrapper',
            '.slick-track',
            '.carousel-inner',
            '.owl-stage',
            '.splide__list',
            '[class*="swiper"]',
            '[class*="slider"]',
            '[class*="carousel"]'
          ];

          // Function to extract text from carousel items
          const extractCarouselText = () => {
            for (const containerSel of carouselContainerSelectors) {
              const containers = document.querySelectorAll(containerSel);
              containers.forEach(container => {
                // Get all visible slides/items
                const items = container.querySelectorAll('[class*="slide"], [class*="item"], [class*="card"]');
                items.forEach(item => {
                  const text = item.innerText?.trim();
                  if (text && text.length > 10) {
                    collectedContent.add(text);
                  }
                });
              });
            }
          };

          // Collect initial content
          extractCarouselText();

          // Method 1: Click through pagination dots (most reliable)
          for (const selector of paginationSelectors) {
            const dots = document.querySelectorAll(selector);
            if (dots.length > 1) {
              for (const dot of dots) {
                try {
                  if (dot && dot.offsetParent !== null) {
                    dot.click();
                    await new Promise(r => setTimeout(r, 400));
                    extractCarouselText();
                  }
                } catch {
                  // Continue to next dot
                }
              }
            }
          }

          // Method 2: Click next button repeatedly
          for (const selector of carouselNextSelectors) {
            const buttons = document.querySelectorAll(selector);
            for (const btn of buttons) {
              if (!btn || btn.offsetParent === null) continue; // Skip invisible buttons

              // Click through carousel multiple times
              for (let i = 0; i < 20; i++) {
                try {
                  btn.click();
                  await new Promise(r => setTimeout(r, 400)); // Wait for animation
                  extractCarouselText(); // Collect content after each click
                } catch {
                  break;
                }
              }
            }
          }

          return Array.from(collectedContent).join('\n\n');
        });
      } catch (e) {
        // Carousel handling is optional, continue if it fails
        console.log(`    Carousel extraction skipped: ${e.message}`);
      }

      let html = await page.content();

      // Append carousel content to the HTML so it gets extracted
      if (carouselContent && carouselContent.length > 100) {
        html += `\n<!-- CAROUSEL_CONTENT_START -->\n<div class="extracted-carousel-content">${carouselContent}</div>\n<!-- CAROUSEL_CONTENT_END -->`;
        console.log(`    + Extracted ${carouselContent.length} chars from carousels`);
      }
      const $ = cheerio.load(html);
      const pageData = extractPageData($, url);
      const totalMs = Date.now() - startedAt;
      console.log(`    ✓ ${url.slice(0, 70)} (${navMs}ms nav, ${totalMs}ms total, ${pageData.content.length} chars${attempt === 2 ? ', retry' : ''})`);

      // Extract links for next depth
      // Prioritize navigation links which often contain the most important pages
      const navLinks = $('nav a[href], header a[href], [role="navigation"] a[href], .nav a[href], .menu a[href], .navigation a[href]')
        .map((_, el) => $(el).attr('href'))
        .get();

      const allLinks = $('a[href]')
        .map((_, el) => $(el).attr('href'))
        .get();

      // Combine nav links first (they're most important), then other links
      const combinedLinks = [...new Set([...navLinks, ...allLinks])];

      const links = combinedLinks
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

/**
 * Scrape a website with optional progress callback for streaming updates
 * @param {string} startUrl - URL to start scraping from
 * @param {number} maxDepth - Maximum link depth to follow
 * @param {number} maxPages - Maximum pages to scrape
 * @param {function} onProgress - Optional callback for progress updates
 */
export async function scrapeClinicWebsite(startUrl, maxDepth = 10, maxPages = 50, onProgress = null) {
  const cleanStartUrl = normalizeUrl(startUrl, startUrl);
  const CONCURRENCY = Number(process.env.SCRAPER_CONCURRENCY) || 3;
  const NAV_TIMEOUT_MS = Number(process.env.SCRAPER_NAV_TIMEOUT_MS) || 15000;
  const RENDER_WAIT_MS = Number(process.env.SCRAPER_RENDER_WAIT_MS) || 500;
  const MAX_PAGES = Number(process.env.SCRAPER_MAX_PAGES) || maxPages;

  // Helper to send progress updates
  const sendProgress = (type, data) => {
    if (onProgress) {
      onProgress({ type, ...data, timestamp: Date.now() });
    }
  };

  sendProgress('start', { url: cleanStartUrl, maxPages: MAX_PAGES });

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
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    if (/google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.com|hotjar\.com|intercom\.io/i.test(request.url())) {
      return route.abort();
    }
    return route.continue();
  });

  const visited = new Set();
  const scrapedPages = [];
  const sitemapUrls = await discoverSitemapUrls(cleanStartUrl);
  if (sitemapUrls.length > 0) {
    console.log(`Sitemap discovered ${sitemapUrls.length} urls`);
  }
  let currentDepthUrls = [cleanStartUrl, ...sitemapUrls];
  let totalLinksFound = 0;

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
      sendProgress('depth', { depth, pagesToScrape: urlsToScrape.length, totalScraped: scrapedPages.length });

      const nextDepthLinks = [];

      // Process in batches of CONCURRENCY
      for (let i = 0; i < urlsToScrape.length; i += CONCURRENCY) {
        const batch = urlsToScrape.slice(i, i + CONCURRENCY);

        // Send progress for pages being scraped
        batch.forEach(url => {
          sendProgress('scraping', { url, pagesScraped: scrapedPages.length, maxPages: MAX_PAGES });
        });

        const results = await Promise.all(
          batch.map(url => scrapeSinglePage(context, url, cleanStartUrl, NAV_TIMEOUT_MS, RENDER_WAIT_MS))
        );

        results.forEach((result, idx) => {
          if (result) {
            scrapedPages.push(result.pageData);
            totalLinksFound += result.links.length;
            if (depth < maxDepth) {
              nextDepthLinks.push(...result.links);
            }
            // Send progress for completed page
            sendProgress('page_done', {
              url: batch[idx],
              title: result.pageData.title || result.pageData.h1,
              contentLength: result.pageData.content.length,
              linksFound: result.links.length,
              pagesScraped: scrapedPages.length,
              maxPages: MAX_PAGES,
              totalLinksFound
            });
          } else {
            sendProgress('page_error', { url: batch[idx], pagesScraped: scrapedPages.length });
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
  sendProgress('scrape_complete', {
    pagesScraped: scrapedPages.length,
    totalLinksFound
  });

  return scrapedPages;
}
