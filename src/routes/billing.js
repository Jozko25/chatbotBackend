import { Router } from 'express';
import prisma from '../services/prisma.js';
import stripe from '../services/stripe.js';
import { strictLimiter } from '../middleware/rateLimiter.js';
import { getPriceIdForPlan, SUPPORTED_CURRENCIES } from '../config/billing.js';

const router = Router();

function getFrontendUrl() {
  const raw = process.env.FRONTEND_URL || 'http://localhost:3000';
  const candidates = raw.split(',').map((value) => value.trim()).filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString().replace(/\/$/, '');
      }
    } catch {
      // Ignore invalid URLs and continue.
    }
  }

  return 'http://localhost:3000';
}

function normalizePlan(plan) {
  return typeof plan === 'string' ? plan.trim().toUpperCase() : null;
}

function normalizeCurrency(currency) {
  return typeof currency === 'string' ? currency.trim().toUpperCase() : 'EUR';
}

// Get current billing status
router.get('/status', async (req, res) => {
  const user = req.user;
  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id }
  });

  res.json({
    plan: user.plan,
    stripeCustomerId: user.stripeCustomerId,
    subscription: subscription ? {
      id: subscription.id,
      status: subscription.status,
      priceId: subscription.priceId,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd
    } : null
  });
});

// Create Stripe Checkout session
router.post('/checkout', strictLimiter, async (req, res) => {
  try {
    const user = req.user;
    const plan = normalizePlan(req.body?.plan);
    const currency = normalizeCurrency(req.body?.currency);

    if (!plan || !['STARTER', 'PRO', 'ENTERPRISE'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return res.status(400).json({ error: 'Unsupported currency' });
    }

    const priceId = getPriceIdForPlan(plan, currency);
    if (!priceId) {
      return res.status(500).json({ error: 'Pricing is not configured for this plan/currency' });
    }

    let stripeCustomerId = user.stripeCustomerId;
    const existingSubscription = await prisma.subscription.findUnique({
      where: { userId: user.id }
    });

    if (existingSubscription && ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(existingSubscription.status)) {
      stripeCustomerId = stripeCustomerId || existingSubscription.stripeCustomerId;
      if (!stripeCustomerId) {
        return res.status(400).json({ error: 'No Stripe customer found for this account' });
      }
      const portal = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: `${getFrontendUrl()}/dashboard/billing`
      });
      return res.json({ url: portal.url });
    }
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || undefined,
        metadata: { userId: user.id }
      });
      stripeCustomerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId }
      });
    }

    const frontendUrl = getFrontendUrl();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/dashboard/billing?canceled=1`,
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      automatic_tax: { enabled: true },
      customer_update: {
        address: 'auto',
        name: 'auto'
      },
      locale: 'auto',
      metadata: { userId: user.id, plan, currency },
      subscription_data: {
        metadata: { userId: user.id, plan }
      },
      client_reference_id: user.id
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout error', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create Stripe Billing Portal session
router.post('/portal', strictLimiter, async (req, res) => {
  try {
    const user = req.user;

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe customer found for this account' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${getFrontendUrl()}/dashboard/billing`
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe portal error', error);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

export default router;
