# Testing the Stripe Webhook

Your webhook is mounted at **`POST /webhooks/stripe`** and handles:

- `checkout.session.completed` – after a subscription checkout
- `customer.subscription.created` / `updated` / `deleted`

---

## Testing on your live site (xelochat.com)

Use this when your API is already live (e.g. at xelochat.com or your Railway/hosted backend) and you want to confirm Stripe **will send** webhooks to it and that your server **responds correctly**.

### 1. Know your live webhook URL

Your endpoint is:

```text
https://<YOUR-LIVE-API-HOST>/webhooks/stripe
```

Examples:

- If your API is at `https://api.xelochat.com` → `https://api.xelochat.com/webhooks/stripe`
- If it’s at a Railway URL like `https://chatbotbackend-production-814f.up.railway.app` → `https://chatbotbackend-production-814f.up.railway.app/webhooks/stripe`

Use the base URL that your frontend (xelochat.com) calls for API requests, then add `/webhooks/stripe`.

### 2. Add the endpoint in Stripe Dashboard

1. Go to [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks).
2. Make sure you’re in **Live** or **Test** mode (top-right) depending on which keys you use in production.
3. Click **Add endpoint**.
4. **Endpoint URL:** paste your live URL, e.g. `https://api.xelochat.com/webhooks/stripe`.
5. Under **Select events to listen to**, add:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
6. Click **Add endpoint**.

### 3. Set the signing secret on your live server

1. On the new webhook’s page, click **Reveal** next to **Signing secret**.
2. Copy the value (`whsec_...`).
3. In your **production** environment (Railway, Vercel, etc.), set:
   ```env
   STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
   ```
4. Redeploy or restart the backend so it picks up the new env var.

### 4. Send a test webhook from Stripe

1. In Stripe Dashboard → **Developers → Webhooks**, open your endpoint.
2. Click **Send test webhook**.
3. Choose an event, e.g. **customer.subscription.created**.
4. Click **Send test webhook**.

### 5. Confirm webhooks are being sent and accepted

- In the same Webhooks page, open **Recent deliveries** (or the **Events** tab for that endpoint).
- You should see the test event with response **200** if your server accepted it.
- If you see **4xx** or **5xx**, click the event to see the response body; that’s what your server returned (e.g. “Missing Stripe signature”, “Webhook Error: …”).
- Optionally check your **server logs** (Railway, etc.) to confirm the webhook handler ran and didn’t throw.

Once you see **200** for “Send test webhook”, Stripe is successfully sending webhooks to your live URL and your app is verifying the signature and responding. Real subscription events (after a live checkout) will use the same endpoint.

---

## 1. Prerequisites

- **STRIPE_SECRET_KEY** and **STRIPE_WEBHOOK_SECRET** in `.env`
- Backend running (e.g. `http://localhost:3001` or your port)
- For local testing, Stripe must be able to reach your server (see options below)

---

## 2. Option A: Stripe CLI (recommended)

Stripe CLI forwards events from Stripe to your local server and signs them with a temporary webhook secret.

### Install Stripe CLI

- **macOS (Homebrew):** `brew install stripe/stripe-cli/stripe`
- **Windows:** `scoop install stripe`
- Or download: https://stripe.com/docs/stripe-cli

### Login and get a forwarding secret

```bash
stripe login
```

Start forwarding events to your local webhook:

```bash
stripe listen --forward-to localhost:3001/webhooks/stripe
```

The CLI will print something like:

```
Ready! Your webhook signing secret is whsec_xxxxxxxxxxxxx
```

### Use that secret locally

1. Copy the `whsec_...` value.
2. In your backend `.env`, set:
   ```env
   STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
   ```
3. Restart your backend so it picks up the new secret.

### Trigger test events

In a **second terminal** (keep `stripe listen` running):

```bash
# Simulate checkout completed (subscription)
stripe trigger checkout.session.completed

# Simulate subscription created
stripe trigger customer.subscription.created

# Simulate subscription updated
stripe trigger customer.subscription.updated

# Simulate subscription deleted
stripe trigger customer.subscription.deleted
```

Each trigger sends a real Stripe event to `localhost:3001/webhooks/stripe` with a valid signature. Check your backend logs and database (e.g. `Subscription`, `User.plan`, `StripeEvent`).

**Note:** Triggered events often don’t have a real user/subscription in your DB, so you may see logs like “no user found for subscription”. That’s normal for raw triggers. For full flow testing, use Option B or C.

---

## 3. Option B: Stripe Dashboard “Send test webhook”

1. Go to [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks).
2. Click **Add endpoint**.
3. **Endpoint URL:**  
   - Local: use a tunnel (e.g. ngrok) so Stripe can reach your machine, e.g. `https://abc123.ngrok.io/webhooks/stripe`.  
   - Staging: use your staging base URL, e.g. `https://api-staging.yourapp.com/webhooks/stripe`.
4. Select events to send:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Create the endpoint. Stripe shows the **Signing secret** (`whsec_...`).
6. Put that in `.env` as **STRIPE_WEBHOOK_SECRET** and restart the backend.
7. In the webhook’s page, click **Send test webhook** and pick an event.

Again, test events may not match a real user in your DB; they’re good for “does the endpoint respond and verify the signature?”.

---

## 4. Option C: Real flow (Checkout → webhook)

Best way to verify end-to-end behavior:

1. Use **Stripe test mode** (test API keys in `.env`).
2. Expose your local backend to the internet (e.g. `ngrok http 3001`).
3. In Stripe Dashboard → Webhooks, add an endpoint with URL `https://<your-ngrok-host>/webhooks/stripe`, select the subscription events above, and copy the signing secret into **STRIPE_WEBHOOK_SECRET**.
4. In your app, go through billing and complete a **test** subscription checkout (use card `4242 4242 4242 4242`).
5. Stripe will send `checkout.session.completed` and subscription events to your webhook.
6. Check:
   - Backend logs (no 4xx/5xx from the webhook).
   - DB: `Subscription` row for the user, `User.plan` and `messageLimit` updated, `StripeEvent` rows with `processedAt` set.

---

## 5. Quick checks

| Check | How |
|-------|-----|
| Webhook endpoint exists | `curl -X POST http://localhost:3001/webhooks/stripe` → 400 “Missing Stripe signature” (expected without signature). |
| Signature verification | Send an event without or with wrong signature → 400 “Webhook Error: …”. |
| Idempotency | Same event ID twice → first time 200 and DB updated, second time 200 and no duplicate work (see `StripeEvent.processedAt`). |
| Subscription logic | After a real test checkout, inspect `Subscription` and `User` in the DB. |

---

## 6. Troubleshooting

- **500 “Stripe webhook secret not configured”**  
  Set `STRIPE_WEBHOOK_SECRET` in `.env` and restart.

- **400 “Missing Stripe signature”**  
  Request didn’t include `Stripe-Signature` header. Use Stripe CLI or Dashboard “Send test webhook”; don’t send raw JSON with curl without signing.

- **400 “Webhook Error: …” (signature verification failed)**  
  Wrong or outdated `STRIPE_WEBHOOK_SECRET`, or body was parsed as JSON (e.g. by `express.json()`). Your app correctly uses `express.raw({ type: 'application/json' })` only for `/webhooks/stripe`.

- **“no user found for subscription”**  
  Triggered events often have random customer/subscription IDs. Use a real test checkout (Option C) or ensure the subscription has `metadata.userId` or a customer that exists in your `User` table.

- **Events not reaching localhost**  
  Stripe can’t call your machine. Use Stripe CLI (`stripe listen`) or ngrok (or similar) and point Stripe to the public URL.
