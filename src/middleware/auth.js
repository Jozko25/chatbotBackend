import { auth } from 'express-oauth2-jwt-bearer';
import prisma from '../services/prisma.js';
import { PLAN_LIMITS } from '../config/billing.js';

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

  console.log('\n========== AUTH DEBUG ==========');
  console.log('auth0Sub:', auth0Sub);
  console.log('email:', email);
  console.log('name:', name);
  console.log('================================\n');

  try {
    // First, try to find user by auth0Sub
    let user = await prisma.user.findUnique({
      where: { auth0Sub }
    });
    console.log('[Auth] Find by auth0Sub:', user ? `Found user ${user.id} (${user.email})` : 'Not found');

    // Also check if there's a user with this email
    const userByEmail = await prisma.user.findUnique({
      where: { email }
    });
    console.log('[Auth] Find by email:', userByEmail ? `Found user ${userByEmail.id} (${userByEmail.auth0Sub})` : 'Not found');

    if (user && userByEmail && user.id !== userByEmail.id) {
      // CONFLICT: Two different users exist - one by auth0Sub, one by email
      // This means we need to merge them. Keep the one with better plan/more data.
      console.log('[Auth] CONFLICT: Two users found, merging...');

      // Decide which user to keep (prefer the one with better plan or more chatbots)
      const keepUser = userByEmail.plan !== 'FREE' ? userByEmail :
                       user.plan !== 'FREE' ? user : userByEmail;
      const deleteUser = keepUser.id === user.id ? userByEmail : user;

      console.log(`[Auth] Keeping user ${keepUser.id} (${keepUser.plan}), deleting ${deleteUser.id} (${deleteUser.plan})`);

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
      console.log(`[Auth] Deleted duplicate user ${deleteUser.id}`);

      // Update the kept user with new auth0Sub and info
      user = await prisma.user.update({
        where: { id: keepUser.id },
        data: {
          auth0Sub,
          email,
          name: name || keepUser.name,
          avatarUrl: avatarUrl || keepUser.avatarUrl,
          lastLoginAt: new Date()
        }
      });
      console.log('[Auth] Merged user updated');

    } else if (user) {
      // User found by auth0Sub - check if email changed
      if (user.email !== email) {
        console.log(`[Auth] Email changed from ${user.email} to ${email}`);
      }
      console.log('[Auth] Updating existing user by auth0Sub');
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
      // Not found by auth0Sub but found by email - link accounts
      console.log(`[Auth] LINKING: Updating auth0Sub from ${userByEmail.auth0Sub} to ${auth0Sub}`);
      user = await prisma.user.update({
        where: { id: userByEmail.id },
        data: {
          auth0Sub,
          name: name || userByEmail.name,
          avatarUrl: avatarUrl || userByEmail.avatarUrl,
          lastLoginAt: new Date()
        }
      });
      console.log('[Auth] Account linked successfully');
    } else {
      // No existing user - create new
      console.log('[Auth] Creating new user');
      user = await prisma.user.create({
        data: {
          auth0Sub,
          email,
          name,
          avatarUrl,
          plan: 'FREE',
          messageLimit: PLAN_LIMITS.FREE.messages,
          messagesUsed: 0,
          limitResetAt: getNextMonthStart()
        }
      });
      console.log('[Auth] New user created:', user.id);
    }

    // Check if we need to reset monthly usage
    user = await resetMonthlyUsageIfNeeded(user);

    console.log('[Auth] Final user:', { id: user.id, email: user.email, plan: user.plan });
    req.user = user;
    next();
  } catch (error) {
    console.error('========== AUTH ERROR ==========');
    console.error('Error:', error.message);
    console.error('Full error:', error);
    console.error('================================');
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
