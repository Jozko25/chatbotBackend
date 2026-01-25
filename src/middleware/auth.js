import { verifyToken } from '@clerk/backend';
import prisma from '../services/prisma.js';
import { PLAN_LIMITS } from '../config/billing.js';
import { clerkClient, requireClerkSecretKey } from '../services/clerk.js';

// Debug logging
const DEBUG = true;
function debugLog(category, ...args) {
  if (DEBUG) {
    console.log(`[AUTH:${category}]`, new Date().toISOString(), ...args);
  }
}

// Clerk JWT validation middleware
export async function requireAuth(req, res, next) {
  debugLog('VERIFY', 'Starting token verification for', req.method, req.path);

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  debugLog('VERIFY', 'Token present:', !!token, token ? `(length: ${token.length})` : '');

  if (!token) {
    debugLog('VERIFY', 'REJECTED: No token provided');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let secretKey;
  try {
    secretKey = requireClerkSecretKey();
    debugLog('VERIFY', 'Clerk secret key loaded, length:', secretKey?.length);
  } catch (error) {
    debugLog('VERIFY', 'REJECTED: Missing Clerk secret key:', error.message);
    return res.status(500).json({ error: 'Authentication misconfigured' });
  }

  try {
    debugLog('VERIFY', 'Calling verifyToken...');
    const payload = await verifyToken(token, { secretKey });
    debugLog('VERIFY', 'Token VALID! User:', payload.sub);
    req.auth = { payload };
    return next();
  } catch (error) {
    debugLog('VERIFY', 'Token INVALID:', error.message);
    debugLog('VERIFY', 'Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Middleware to attach user to request (create if not exists)
export async function attachUser(req, res, next) {
  debugLog('USER', 'attachUser called for', req.method, req.path);

  if (!req.auth?.payload?.sub) {
    debugLog('USER', 'REJECTED: No auth payload');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!clerkClient) {
    debugLog('USER', 'REJECTED: Clerk client not configured');
    return res.status(500).json({ error: 'Authentication misconfigured' });
  }

  try {
    const clerkUserId = req.auth.payload.sub;
    debugLog('USER', 'Fetching Clerk user:', clerkUserId);
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    debugLog('USER', 'Clerk user fetched:', clerkUser.emailAddresses?.[0]?.emailAddress);

    const primaryEmail = clerkUser.emailAddresses.find(
      (emailAddress) => emailAddress.id === clerkUser.primaryEmailAddressId
    )?.emailAddress;
    const email = primaryEmail || clerkUser.emailAddresses[0]?.emailAddress || `${clerkUserId}@clerk.local`;
    const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || null;
    const avatarUrl = clerkUser.imageUrl || null;

    // First, try to find user by clerkUserId
    let user = await prisma.user.findUnique({
      where: { clerkUserId }
    });

    // Also check if there's a user with this email
    const userByEmail = await prisma.user.findUnique({
      where: { email }
    });

    if (user && userByEmail && user.id !== userByEmail.id) {
      // CONFLICT: Two different users exist - one by clerkUserId, one by email
      // This means we need to merge them. Keep the one with better plan/more data.
      const keepUser = userByEmail.plan !== 'FREE' ? userByEmail :
                       user.plan !== 'FREE' ? user : userByEmail;
      const deleteUser = keepUser.id === user.id ? userByEmail : user;

      // Transfer chatbots from deleted user to kept user
      await prisma.chatbot.updateMany({
        where: { userId: deleteUser.id },
        data: { userId: keepUser.id }
      });

      // Transfer API keys
      await prisma.apiKey.updateMany({
        where: { userId: deleteUser.id },
        data: { userId: keepUser.id }
      });

      // Delete the duplicate user
      await prisma.user.delete({
        where: { id: deleteUser.id }
      });

      // Update the kept user with new clerkUserId and info
      user = await prisma.user.update({
        where: { id: keepUser.id },
        data: {
          clerkUserId,
          email,
          name: name || keepUser.name,
          avatarUrl: avatarUrl || keepUser.avatarUrl,
          lastLoginAt: new Date()
        }
      });

    } else if (user) {
      // User found by clerkUserId - update with latest info
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          email,
          name,
          avatarUrl,
          lastLoginAt: new Date()
        }
      });
    } else if (userByEmail) {
      // Not found by clerkUserId but found by email - link accounts
      user = await prisma.user.update({
        where: { id: userByEmail.id },
        data: {
          clerkUserId,
          name: name || userByEmail.name,
          avatarUrl: avatarUrl || userByEmail.avatarUrl,
          lastLoginAt: new Date()
        }
      });
    } else {
      // No existing user - create new
      user = await prisma.user.create({
        data: {
          clerkUserId,
          email,
          name,
          avatarUrl,
          plan: 'FREE',
          messageLimit: PLAN_LIMITS.FREE.messages,
          messagesUsed: 0,
          limitResetAt: getNextMonthStart()
        }
      });
    }

    // Check if we need to reset monthly usage
    user = await resetMonthlyUsageIfNeeded(user);

    debugLog('USER', 'User attached successfully:', { id: user.id, email: user.email, plan: user.plan });
    req.user = user;
    next();
  } catch (error) {
    debugLog('USER', 'FAILED to sync user:', error.message);
    debugLog('USER', 'Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    return res.status(500).json({ error: 'Failed to sync user' });
  }
}

// Helper to get first day of next month
function getNextMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

export async function resetMonthlyUsageIfNeeded(user) {
  const now = new Date();
  if (user.limitResetAt && user.limitResetAt <= now) {
    return prisma.user.update({
      where: { id: user.id },
      data: {
        messagesUsed: 0,
        limitResetAt: getNextMonthStart()
      }
    });
  }
  return user;
}

// Combined middleware for protected routes
export const protectedRoute = [requireAuth, attachUser];

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
