import { Router } from 'express';
import prisma from '../services/prisma.js';
import stripe from '../services/stripe.js';
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

async function deleteAuth0User(auth0Sub) {
  const domain = process.env.AUTH0_MGMT_DOMAIN;
  const clientId = process.env.AUTH0_MGMT_CLIENT_ID;
  const clientSecret = process.env.AUTH0_MGMT_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    return { attempted: false };
  }

  const tokenResponse = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`,
      grant_type: 'client_credentials'
    })
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Auth0 token error: ${errorText}`);
  }

  const { access_token: accessToken } = await tokenResponse.json();

  const deleteResponse = await fetch(`https://${domain}/api/v2/users/${encodeURIComponent(auth0Sub)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!deleteResponse.ok) {
    const errorText = await deleteResponse.text();
    throw new Error(`Auth0 delete error: ${errorText}`);
  }

  return { attempted: true };
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

    await deleteAuth0User(user.auth0Sub);

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
