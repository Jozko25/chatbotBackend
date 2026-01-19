import rateLimit from 'express-rate-limit';

// General API rate limit
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, please try again later', code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false
});

// Scraping rate limit (more restrictive)
export const scrapeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 scrapes per minute
  message: { error: 'Scraping rate limit exceeded. Please wait before trying again.', code: 'SCRAPE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false
});

// Chat rate limit
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages per minute
  message: { error: 'Chat rate limit exceeded. Please slow down.', code: 'CHAT_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false
});

// Widget rate limit (per API key)
export const widgetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 requests per minute per API key
  message: { error: 'Widget rate limit exceeded', code: 'WIDGET_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false
});
