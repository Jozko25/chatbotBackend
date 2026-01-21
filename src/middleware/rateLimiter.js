import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// Key generator for per-user rate limiting
const getUserKey = (req) => {
  // For authenticated routes, use user ID
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  // For API key routes, use API key hash
  if (req.apiKeyData?.keyHash) {
    return `apikey:${req.apiKeyData.keyHash}`;
  }
  // Fallback to IP address (IPv6-safe helper)
  return ipKeyGenerator(req);
};

// General API rate limit (per IP or user)
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  keyGenerator: getUserKey,
  message: { error: 'Too many requests, please try again later', code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limit for health checks
    return req.path === '/health' || req.path === '/';
  }
});

// Scraping rate limit (more restrictive, per user)
export const scrapeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 scrapes per minute per user
  keyGenerator: getUserKey,
  message: { error: 'Scraping rate limit exceeded. Please wait before trying again.', code: 'SCRAPE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false
});

// Chat rate limit (per user)
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages per minute per user
  keyGenerator: getUserKey,
  message: { error: 'Chat rate limit exceeded. Please slow down.', code: 'CHAT_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false
});

// Widget rate limit (per API key)
export const widgetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 requests per minute per API key
  keyGenerator: getUserKey,
  message: { error: 'Widget rate limit exceeded', code: 'WIDGET_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false
});

// Strict rate limit for sensitive operations (e.g., booking submissions)
export const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 requests per minute
  keyGenerator: getUserKey,
  message: { error: 'Too many requests. Please wait a moment.', code: 'STRICT_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false
});
