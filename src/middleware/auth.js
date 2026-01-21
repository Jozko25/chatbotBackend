import { auth } from 'express-oauth2-jwt-bearer';
import prisma from '../services/prisma.js';

// Auth0 JWT validation middleware
export const requireAuth = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
  tokenSigningAlg: 'RS256'
});

// Middleware to attach user to request (create if not exists)
export async function attachUser(req, res, next) {
  if (!req.auth?.payload?.sub) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const auth0Sub = req.auth.payload.sub;
  // Auth0 includes email in different claim depending on connection type
  const email = req.auth.payload.email ||
                req.auth.payload['https://xelochat.com/email'] ||
                `${auth0Sub}@auth0.local`;
  const name = req.auth.payload.name ||
               req.auth.payload['https://xelochat.com/name'] ||
               null;
  const avatarUrl = req.auth.payload.picture || null;

  try {
    // Upsert user - create if doesn't exist, update if exists
    let user = await prisma.user.upsert({
      where: { auth0Sub },
      update: {
        email,
        name,
        avatarUrl,
        lastLoginAt: new Date()
      },
      create: {
        auth0Sub,
        email,
        name,
        avatarUrl,
        plan: 'FREE',
        messageLimit: 100,
        messagesUsed: 0,
        limitResetAt: getNextMonthStart()
      }
    });

    // Check if we need to reset monthly usage
    const now = new Date();
    if (user.limitResetAt <= now) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          messagesUsed: 0,
          limitResetAt: getNextMonthStart()
        }
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('User sync error:', error);
    return res.status(500).json({ error: 'Failed to sync user' });
  }
}

// Helper to get first day of next month
function getNextMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

// Combined middleware for protected routes
export const protectedRoute = [requireAuth, attachUser];

// Plan limits configuration
export const PLAN_LIMITS = {
  FREE: { chatbots: 1, messages: 100 },
  STARTER: { chatbots: 3, messages: 1000 },
  PRO: { chatbots: 10, messages: 10000 },
  ENTERPRISE: { chatbots: 999, messages: 999999 }
};

// Middleware to check chatbot limit
export async function checkChatbotLimit(req, res, next) {
  const user = req.user;
  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.FREE;

  // Count only ACTIVE and PAUSED chatbots (not DELETED)
  const chatbotCount = await prisma.chatbot.count({
    where: {
      userId: user.id,
      status: { in: ['ACTIVE', 'PAUSED'] }
    }
  });

  console.log(`[Chatbot Limit Check] User: ${user.email}, Plan: ${user.plan}, Active: ${chatbotCount}, Limit: ${limits.chatbots}`);

  if (chatbotCount >= limits.chatbots) {
    return res.status(403).json({
      error: `Chatbot limit reached (${chatbotCount}/${limits.chatbots}) for ${user.plan} plan. Please upgrade or delete existing chatbots.`,
      code: 'CHATBOT_LIMIT_REACHED',
      currentCount: chatbotCount,
      limit: limits.chatbots
    });
  }

  next();
}

// Middleware to check message limit
export async function checkMessageLimit(req, res, next) {
  const user = req.user;
  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.FREE;

  if (user.messagesUsed >= limits.messages) {
    return res.status(429).json({
      error: `Message limit reached (${limits.messages}) for ${user.plan} plan. Please upgrade.`,
      code: 'MESSAGE_LIMIT_REACHED'
    });
  }

  next();
}
