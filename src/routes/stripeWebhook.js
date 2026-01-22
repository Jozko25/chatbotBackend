import { Router } from 'express';
import prisma from '../services/prisma.js';
import stripe from '../services/stripe.js';
import { getPlanForPriceId, PLAN_LIMITS } from '../config/billing.js';

const router = Router();

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

function getNextMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

async function upsertSubscription({ userId, stripeCustomerId, subscription }) {
  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  const planFromPrice = getPlanForPriceId(priceId);
  const status = subscription.status;
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);

  const existing = await prisma.subscription.findUnique({
    where: { userId }
  });

  if (existing) {
    await prisma.subscription.update({
      where: { userId },
      data: {
        stripeCustomerId,
        stripeSubscriptionId: subscription.id,
        status,
        priceId: priceId || existing.priceId,
        currentPeriodEnd,
        cancelAtPeriodEnd
      }
    });
  } else {
    await prisma.subscription.upsert({
      where: { stripeSubscriptionId: subscription.id },
      update: {
        stripeCustomerId,
        status,
        priceId: priceId || undefined,
        currentPeriodEnd,
        cancelAtPeriodEnd
      },
      create: {
        userId,
        stripeCustomerId,
        stripeSubscriptionId: subscription.id,
        status,
        priceId: priceId || 'unknown',
        currentPeriodEnd,
        cancelAtPeriodEnd
      }
    });
  }

  const shouldEnablePaidPlan = ACTIVE_STATUSES.has(status) && planFromPrice;
  if (ACTIVE_STATUSES.has(status) && !planFromPrice) {
    console.warn('Stripe webhook: unknown price ID', priceId);
  }
  const plan = shouldEnablePaidPlan ? planFromPrice : 'FREE';
  const messageLimit = PLAN_LIMITS[plan]?.messages || PLAN_LIMITS.FREE.messages;
  const limitResetAt = shouldEnablePaidPlan
    ? (currentPeriodEnd || undefined)
    : getNextMonthStart();

  await prisma.user.update({
    where: { id: userId },
    data: {
      plan,
      messageLimit,
      limitResetAt
    }
  });
}

async function handleSubscriptionEvent(subscription) {
  let fullSubscription = subscription;
  if (!fullSubscription.items?.data?.length) {
    fullSubscription = await stripe.subscriptions.retrieve(subscription.id);
  }

  const stripeCustomerId = typeof fullSubscription.customer === 'string'
    ? fullSubscription.customer
    : fullSubscription.customer?.id;

  const metadataUserId = fullSubscription.metadata?.userId || null;
  let user = null;

  if (metadataUserId) {
    user = await prisma.user.findUnique({ where: { id: metadataUserId } });
  }

  if (!user && stripeCustomerId) {
    user = await prisma.user.findFirst({ where: { stripeCustomerId } });
  }

  if (!user) {
    console.warn('Stripe webhook: no user found for subscription', subscription.id);
    return;
  }

  if (!user.stripeCustomerId && stripeCustomerId) {
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId }
    });
  }

  await upsertSubscription({
    userId: user.id,
    stripeCustomerId: stripeCustomerId || user.stripeCustomerId,
    subscription: fullSubscription
  });
}

router.post('/', async (req, res) => {
  const signatureHeader = req.headers['stripe-signature'];
  const signature = Array.isArray(signatureHeader)
    ? signatureHeader[0]
    : signatureHeader;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return res.status(500).send('Stripe webhook secret not configured');
  }
  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const existingEvent = await prisma.stripeEvent.findUnique({
      where: { stripeEventId: event.id }
    });

    if (existingEvent?.processedAt) {
      return res.json({ received: true });
    }

    await prisma.stripeEvent.upsert({
      where: { stripeEventId: event.id },
      update: {
        type: event.type,
        objectId: event.data?.object?.id || null,
        livemode: event.livemode
      },
      create: {
        stripeEventId: event.id,
        type: event.type,
        objectId: event.data?.object?.id || null,
        livemode: event.livemode
      }
    });

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await handleSubscriptionEvent(subscription);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await handleSubscriptionEvent(subscription);
        break;
      }
      default:
        break;
    }

    await prisma.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: { processedAt: new Date() }
    });

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handler error', error);
    res.status(500).send('Webhook handler error');
  }
});



export default router;
