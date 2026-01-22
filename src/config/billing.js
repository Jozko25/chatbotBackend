export const PLAN_LIMITS = {
  FREE: { chatbots: 1, messages: 50 },
  STARTER: { chatbots: 2, messages: 500 },
  PRO: { chatbots: 4, messages: 2000 },
  ENTERPRISE: { chatbots: 999, messages: 999999 }
};

export const SUPPORTED_CURRENCIES = ['EUR'];

export const STRIPE_PRICE_IDS = {
  STARTER: {
    EUR: process.env.STRIPE_PRICE_STARTER_EUR || 'price_1SsMV97bUpmDP5Z7aABBLn55'
  },
  PRO: {
    EUR: process.env.STRIPE_PRICE_PRO_EUR || 'price_1SsMWn7bUpmDP5Z7pOo2wijX'
  },
  ENTERPRISE: {
    EUR: process.env.STRIPE_PRICE_ENTERPRISE_EUR
  }
};

export function getPriceIdForPlan(plan, currency) {
  const planConfig = STRIPE_PRICE_IDS[plan];
  if (!planConfig) return null;
  const normalizedCurrency = currency?.toUpperCase();
  return planConfig[normalizedCurrency] || null;
}

export function getPlanForPriceId(priceId) {
  if (!priceId) return null;
  for (const [plan, currencies] of Object.entries(STRIPE_PRICE_IDS)) {
    for (const id of Object.values(currencies)) {
      if (id && id === priceId) return plan;
    }
  }
  return null;
}
