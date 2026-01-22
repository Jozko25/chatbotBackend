import crypto from 'crypto';
import prisma from '../services/prisma.js';
import { PLAN_LIMITS } from '../config/billing.js';
import { resetMonthlyUsageIfNeeded } from './auth.js';

// Extract domain from origin/referer
function extractDomain(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Check if domain matches allowed domains
function isDomainAllowed(requestDomain, allowedDomains) {
  if (!allowedDomains || allowedDomains.length === 0) {
    // If no domains specified, allow all (for testing/development)
    return true;
  }

  if (!requestDomain) {
    // If we can't determine the request domain, reject
    return false;
  }

  // Normalize and check
  const normalizedRequest = requestDomain.toLowerCase().replace(/^www\./, '');

  return allowedDomains.some(allowed => {
    const normalizedAllowed = allowed.toLowerCase().replace(/^www\./, '');
    // Exact match or subdomain match
    return normalizedRequest === normalizedAllowed ||
           normalizedRequest.endsWith('.' + normalizedAllowed);
  });
}

// API key validation for embed widgets
export async function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required', code: 'API_KEY_MISSING' });
  }

  // Hash the provided key
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  try {
    const key = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        user: true,
        chatbot: true
      }
    });

    if (!key) {
      return res.status(401).json({ error: 'Invalid API key', code: 'API_KEY_INVALID' });
    }

    if (!key.isActive) {
      return res.status(401).json({ error: 'API key has been revoked', code: 'API_KEY_REVOKED' });
    }

    if (key.expiresAt && key.expiresAt < new Date()) {
      return res.status(401).json({ error: 'API key has expired', code: 'API_KEY_EXPIRED' });
    }

    // Check domain whitelist
    const origin = req.headers.origin || req.headers.referer;
    const requestDomain = extractDomain(origin);

    if (!isDomainAllowed(requestDomain, key.allowedDomains)) {
      console.warn(`Domain rejected: ${requestDomain} not in ${JSON.stringify(key.allowedDomains)}`);
      return res.status(403).json({
        error: 'Domain not authorized for this API key',
        code: 'DOMAIN_NOT_ALLOWED'
      });
    }

    const user = await resetMonthlyUsageIfNeeded(key.user);

    // Check user message limits
    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.FREE;
    if (user.messagesUsed >= limits.messages) {
      return res.status(429).json({
        error: 'Message limit exceeded. Please upgrade your plan.',
        code: 'MESSAGE_LIMIT_EXCEEDED'
      });
    }

    // Update last used timestamp (don't await to not slow down request)
    prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() }
    }).catch(err => console.error('Failed to update lastUsedAt:', err));

    // Attach to request
    req.apiKeyData = key;
    req.user = user;
    next();
  } catch (error) {
    console.error('API key validation error:', error);
    return res.status(500).json({ error: 'Authentication failed', code: 'AUTH_ERROR' });
  }
}

// Generate a new API key
export function generateApiKey() {
  const prefix = 'sb_live_';
  const randomPart = crypto.randomBytes(24).toString('base64url');
  return prefix + randomPart;
}

// Hash an API key for storage
export function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}
