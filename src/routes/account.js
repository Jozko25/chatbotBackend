import { Router } from 'express';
import prisma from '../services/prisma.js';
import stripe from '../services/stripe.js';
import { clerkClient } from '../services/clerk.js';
import { strictLimiter } from '../middleware/rateLimiter.js';

const router = Router();

const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete'
]);

async function cancelStripeSubscription(subscriptionId) {
  try {
    if (typeof stripe.subscriptions.cancel === 'function') {
      return await stripe.subscriptions.cancel(subscriptionId);
    }
    return await stripe.subscriptions.del(subscriptionId);
  } catch (error) {
    if (error?.code === 'resource_missing') {
      return null;
    }
    throw error;
  }
}

async function deleteClerkUser(clerkUserId) {
  if (!clerkClient) {
    return { attempted: false };
  }

  try {
    await clerkClient.users.deleteUser(clerkUserId);
    return { attempted: true };
  } catch (error) {
    if (error?.status === 404) {
      return { attempted: false };
    }
    throw error;
  }
}

router.delete('/', strictLimiter, async (req, res) => {
  const user = req.user;

  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id }
    });

    let stripeCustomerId = user.stripeCustomerId || subscription?.stripeCustomerId || null;

    let cancelled = false;
    if (subscription?.stripeSubscriptionId) {
      const result = await cancelStripeSubscription(subscription.stripeSubscriptionId);
      cancelled = Boolean(result);
    }

    if (stripeCustomerId && !cancelled) {
      const subs = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'all',
        limit: 10
      });

      for (const sub of subs.data) {
        if (ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
          await cancelStripeSubscription(sub.id);
        }
      }
    }

    if (stripeCustomerId) {
      try {
        await stripe.customers.del(stripeCustomerId);
      } catch (error) {
        console.warn('Stripe customer delete failed', error);
      }
    }

    await deleteClerkUser(user.clerkUserId);

    await prisma.user.delete({
      where: { id: user.id }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Account delete error', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;
