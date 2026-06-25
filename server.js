// PropDesk Backend Server
// Handles: Myfxbook proxy + Stripe checkout + Stripe webhooks
// Deploy on Render (free tier)

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARS (set in Render dashboard) ──────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRO_PRICE_ID         = process.env.STRIPE_PRO_PRICE_ID         || 'price_1TkNvBJvBLMVit7iFf56DRdt';
const STRIPE_ELITE_PRICE_ID       = process.env.STRIPE_ELITE_PRICE_ID       || 'price_1TkNr2JvBLMVit7iIn40X1Hs';
const STRIPE_PRO_PRICE_ID_ANNUAL   = process.env.STRIPE_PRO_PRICE_ID_ANNUAL   || 'price_1TmByfFOB9bKloCeP1mGRCVd';
const STRIPE_ELITE_PRICE_ID_ANNUAL = process.env.STRIPE_ELITE_PRICE_ID_ANNUAL || 'price_1TmBzEFOB9bKloCeDnIBlnxm';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://afzvlugymcjtenpnolag.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL = process.env.APP_URL || 'https://propdesk-hvn.pages.dev';

const MFB_BASE = 'https://www.myfxbook.com/api';
const PATH_MAP = {
  '/login': '/login.json',
  '/accounts': '/get-my-accounts.json',
  '/history': '/get-history.json',
  '/open-trades': '/get-open-trades.json',
  '/daily-gain': '/get-data-daily.json',
  '/summary': '/get-my-accounts.json',
};

app.use(cors({ origin: '*' }));

// ── RAW BODY for Stripe webhook signature verification ───────
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'PropDesk Backend' });
});

// ── MYFXBOOK PROXY ───────────────────────────────────────────
app.get('/myfxbook/*', async (req, res) => {
  const path = req.path.replace('/myfxbook', '');
  const mfbPath = PATH_MAP[path];
  if (!mfbPath) return res.status(404).json({ error: true, message: 'Unknown endpoint: ' + path });

  const params = new URLSearchParams(req.query).toString();
  const mfbUrl = `${MFB_BASE}${mfbPath}${params ? '?' + params : ''}`;

  try {
    const response = await fetch(mfbUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.myfxbook.com/',
        'Origin': 'https://www.myfxbook.com',
      },
    });
    const text = await response.text();
    res.set('Cache-Control', 'no-store').status(response.status).type('application/json').send(text);
  } catch (err) {
    res.status(502).json({ error: true, message: err.message });
  }
});

// ── STRIPE: CREATE CHECKOUT SESSION ─────────────────────────
app.post('/stripe/create-checkout', async (req, res) => {
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured' });

  const { plan, billing, userId, userEmail } = req.body;
  if (!plan || !userId) return res.status(400).json({ error: 'Missing plan or userId' });

  // Pick price ID based on plan + billing period
  let priceId;
  if (plan === 'elite') {
    priceId = billing === 'annual' ? STRIPE_ELITE_PRICE_ID_ANNUAL : STRIPE_ELITE_PRICE_ID;
  } else {
    priceId = billing === 'annual' ? STRIPE_PRO_PRICE_ID_ANNUAL : STRIPE_PRO_PRICE_ID;
  }

  try {
    const stripe = await import('stripe').then(m => m.default(STRIPE_SECRET_KEY));

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userEmail,
      metadata: { userId, plan, billing: billing || 'monthly' },
      success_url: `${APP_URL}/app.html?upgrade=success&plan=${plan}`,
      cancel_url: `${APP_URL}/app.html?upgrade=cancelled`,
      subscription_data: {
        metadata: { userId, plan, billing: billing || 'monthly' },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: CUSTOMER PORTAL ──────────────────────────────────
app.post('/stripe/portal', async (req, res) => {
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured' });

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const stripe = await import('stripe').then(m => m.default(STRIPE_SECRET_KEY));

    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=stripe_customer_id`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    });
    const subs = await subRes.json();
    const customerId = subs?.[0]?.stripe_customer_id;
    if (!customerId) return res.status(404).json({ error: 'No subscription found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_URL}/app.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: WEBHOOK ──────────────────────────────────────────
app.post('/stripe/webhook', async (req, res) => {
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  let event;
  try {
    const stripe = await import('stripe').then(m => m.default(STRIPE_SECRET_KEY));
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function handleStripeEvent(event) {
  const stripe = await import('stripe').then(m => m.default(STRIPE_SECRET_KEY));

  const upsertSubscription = async (data) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error('Supabase upsert failed: ' + err);
    }
  };

  // Helper — determine plan from any price ID (monthly or annual)
  const getPlanFromPriceId = (priceId) => {
    if (priceId === STRIPE_ELITE_PRICE_ID || priceId === STRIPE_ELITE_PRICE_ID_ANNUAL) return 'elite';
    if (priceId === STRIPE_PRO_PRICE_ID   || priceId === STRIPE_PRO_PRICE_ID_ANNUAL)   return 'pro';
    return 'pro'; // fallback
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan || 'pro';
      if (!userId) break;

      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      await upsertSubscription({
        user_id: userId,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        plan,
        status: 'active',
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });
      console.log(`✅ New ${plan} subscription for user ${userId}`);
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (!userId) break;

      const priceId = sub.items.data[0]?.price?.id;
      const plan = getPlanFromPriceId(priceId);
      const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : 'cancelled';

      await upsertSubscription({
        user_id: userId,
        stripe_customer_id: sub.customer,
        stripe_subscription_id: sub.id,
        plan,
        status,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });
      console.log(`✅ Subscription updated: ${plan} / ${status} for user ${userId}`);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (!userId) break;

      await upsertSubscription({
        user_id: userId,
        stripe_customer_id: sub.customer,
        stripe_subscription_id: sub.id,
        plan: 'starter',
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      });
      console.log(`✅ Subscription cancelled for user ${userId} — downgraded to starter`);
      break;
    }

    default:
      console.log(`Unhandled event: ${event.type}`);
  }
}

app.listen(PORT, () => {
  console.log(`PropDesk backend listening on port ${PORT}`);
});
