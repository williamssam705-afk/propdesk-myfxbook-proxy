// PropDesk Backend Server
// Handles: Myfxbook proxy + Stripe checkout + Stripe webhooks
// Deploy on Render (free tier)

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARS (set in Render dashboard) ──────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'PropDesk <noreply@propdesk.uk>';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRO_PRICE_ID         = process.env.STRIPE_PRO_PRICE_ID         || 'price_1TkNvBJvBLMVit7iFf56DRdt';
const STRIPE_ELITE_PRICE_ID       = process.env.STRIPE_ELITE_PRICE_ID       || 'price_1TkNr2JvBLMVit7iIn40X1Hs';
const STRIPE_PRO_PRICE_ID_ANNUAL   = process.env.STRIPE_PRO_PRICE_ID_ANNUAL   || 'price_1TmJqcJvBLMVit7iNuDFR9dw';
const STRIPE_ELITE_PRICE_ID_ANNUAL = process.env.STRIPE_ELITE_PRICE_ID_ANNUAL || 'price_1TmJqDJvBLMVit7iDgYtqM19';
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
        trial_period_days: 7,
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

      // Send welcome email
      if (session.customer_email) {
        await sendEmail({
          to: session.customer_email,
          subject: 'Welcome to PropDesk 🚀',
          html: welcomeEmail(session.customer_email)
        });

        // Schedule onboarding emails via setTimeout (day 2 = 48h, day 3 = 7 days)
        setTimeout(() => sendEmail({
          to: session.customer_email,
          subject: 'Are you paying too much tax on your prop payouts?',
          html: onboardingEmail2(session.customer_email)
        }), 48 * 60 * 60 * 1000);

        setTimeout(() => sendEmail({
          to: session.customer_email,
          subject: 'One rule could cost you your funded account ⚠️',
          html: onboardingEmail3(session.customer_email)
        }), 7 * 24 * 60 * 60 * 1000);
      }

      // Check if this user was referred — schedule credit after 30 days
      const refRes = await fetch(`${SUPABASE_URL}/rest/v1/referrals?referred_id=eq.${userId}&status=eq.signed_up&select=id,referrer_id`, {
        headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
      });
      const refs = await refRes.json();
      if (refs?.[0]) {
        const ref = refs[0];
        // Mark as paid immediately
        await fetch(`${SUPABASE_URL}/rest/v1/referrals?id=eq.${ref.id}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'paid', first_paid_at: new Date().toISOString() })
        });
        // Check referrer hasn't exceeded 5 credits
        const credRes = await fetch(`${SUPABASE_URL}/rest/v1/referral_credits?user_id=eq.${ref.referrer_id}&select=id`, {
          headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
        });
        const existingCredits = await credRes.json();
        if (existingCredits.length < 5) {
          // Credit both referrer and referred after 30 days (simulated by logging now — you'd use a cron in production)
          // For now, credit immediately — update to 30-day delay when you have a cron job
          const creditBody = JSON.stringify([
            { user_id: ref.referrer_id, amount_months: 1, reason: `Referral credit — friend subscribed`, applied: false },
            { user_id: userId, amount_months: 1, reason: 'Welcome referral credit — 1 month free', applied: false }
          ]);
          await fetch(`${SUPABASE_URL}/rest/v1/referral_credits`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: creditBody
          });
          // Update referral status to credited
          await fetch(`${SUPABASE_URL}/rest/v1/referrals?id=eq.${ref.id}`, {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'credited', credited_at: new Date().toISOString() })
          });
          console.log(`✅ Referral credited: referrer ${ref.referrer_id} + referred ${userId}`);
        }
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (!userId) break;

      const priceId = sub.items.data[0]?.price?.id;
      const plan = getPlanFromPriceId(priceId);
      const status = sub.status === 'active' ? 'active' : sub.status === 'trialing' ? 'trialing' : sub.status === 'past_due' ? 'past_due' : 'cancelled';

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

// ============================================================
// EMAIL SYSTEM (Resend)
// ============================================================
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) { console.log('Resend not configured — skipping email'); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    const data = await res.json();
    if (data.id) { console.log(`✅ Email sent to ${to}: ${subject}`); }
    else { console.error('Email error:', JSON.stringify(data)); }
  } catch (err) { console.error('Email send failed:', err.message); }
}

function welcomeEmail(email) {
  const name = email.split('@')[0];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

  <!-- Header -->
  <tr><td style="background:#07001f;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
      <tr>
        <td style="width:44px;height:44px;background:#6e45ff;border-radius:12px;text-align:center;vertical-align:middle;">
          <span style="font-size:20px;font-weight:900;color:#fff;line-height:44px;">P</span>
        </td>
        <td style="padding-left:12px;font-size:22px;font-weight:900;color:#fff;letter-spacing:0.03em;vertical-align:middle;">
          PROP<span style="color:rgba(255,255,255,0.4);">DESK</span>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:40px;">
    <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#0a0020;letter-spacing:-0.01em;">Welcome to PropDesk 🚀</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">You're in. Here's everything you can do right now to get set up in under 5 minutes.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="background:#f8f7ff;border-radius:12px;padding:20px 24px;border-left:4px solid #6e45ff;">
          <div style="font-size:13px;font-weight:700;color:#6e45ff;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.06em;">Get started in 3 steps</div>
          <div style="font-size:14px;color:#333;line-height:1.8;">
            <b>1.</b> Add your first funded account<br>
            <b>2.</b> Connect Myfxbook for auto-sync (Pro/Elite)<br>
            <b>3.</b> Log your first trade or payout
          </div>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td width="48%" style="background:#f8f7ff;border-radius:12px;padding:18px 20px;vertical-align:top;">
          <div style="font-size:20px;margin-bottom:6px;">📊</div>
          <div style="font-size:13px;font-weight:700;color:#0a0020;margin-bottom:4px;">Trade Journal</div>
          <div style="font-size:12px;color:#888;line-height:1.5;">Log trades, upload screenshots, track your edge.</div>
        </td>
        <td width="4%"></td>
        <td width="48%" style="background:#f8f7ff;border-radius:12px;padding:18px 20px;vertical-align:top;">
          <div style="font-size:20px;margin-bottom:6px;">⚠️</div>
          <div style="font-size:13px;font-weight:700;color:#0a0020;margin-bottom:4px;">Inactivity Alerts</div>
          <div style="font-size:12px;color:#888;line-height:1.5;">Never lose a funded account to a missed day.</div>
        </td>
      </tr>
      <tr><td colspan="3" style="height:12px;"></td></tr>
      <tr>
        <td width="48%" style="background:#f8f7ff;border-radius:12px;padding:18px 20px;vertical-align:top;">
          <div style="font-size:20px;margin-bottom:6px;">💰</div>
          <div style="font-size:13px;font-weight:700;color:#0a0020;margin-bottom:4px;">Payout Tracking</div>
          <div style="font-size:12px;color:#888;line-height:1.5;">Log withdrawals, hit milestones, share your wins.</div>
        </td>
        <td width="4%"></td>
        <td width="48%" style="background:#f8f7ff;border-radius:12px;padding:18px 20px;vertical-align:top;">
          <div style="font-size:20px;margin-bottom:6px;">🧮</div>
          <div style="font-size:13px;font-weight:700;color:#0a0020;margin-bottom:4px;">Tax Calculator</div>
          <div style="font-size:12px;color:#888;line-height:1.5;">Know your tax liability before every withdrawal.</div>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="https://propdesk.uk/app.html" style="display:inline-block;background:#6e45ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:12px;letter-spacing:0.02em;">Open PropDesk →</a>
      </td></tr>
    </table>

    <p style="margin:0;font-size:13px;color:#999;line-height:1.6;">Any questions? Reply to this email — we read every one.</p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f0f0f6;border-radius:0 0 16px 16px;padding:20px 40px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#aaa;line-height:1.6;">
      PropDesk · propdesk.uk<br>
      <a href="https://propdesk.uk" style="color:#6e45ff;text-decoration:none;">Unsubscribe</a>
    </p>
  </td></tr>

</table></td></tr></table>
</body></html>`;
}

function onboardingEmail2(email) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:#07001f;border-radius:16px 16px 0 0;padding:28px 40px;text-align:center;">
    <span style="font-size:20px;font-weight:900;color:#fff;letter-spacing:0.03em;">PROP<span style="color:rgba(255,255,255,0.4);">DESK</span></span>
  </td></tr>
  <tr><td style="background:#fff;padding:40px;">
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0a0020;">Did you know most prop traders overpay tax? 🧮</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#666;line-height:1.6;">Prop firm payouts are self-employment income — not capital gains. That means Income Tax, NIC, and allowable deductions. Most traders don't realise this until they get a surprise bill.</p>
    <p style="margin:0 0 20px;font-size:15px;color:#666;line-height:1.6;">PropDesk calculates your exact liability <strong>before you withdraw</strong> — including challenge fees as deductible expenses.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f7ff;border-radius:12px;padding:20px 24px;margin-bottom:28px;border-left:4px solid #6e45ff;">
      <tr><td>
        <div style="font-size:14px;color:#333;line-height:1.8;">
          ✓ &nbsp;Income Tax at correct self-employment rates<br>
          ✓ &nbsp;NIC thresholds factored in automatically<br>
          ✓ &nbsp;Challenge fees deducted from gross income<br>
          ✓ &nbsp;January payment on account calculated
        </div>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="https://propdesk.uk/app.html" style="display:inline-block;background:#6e45ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:12px;">Try the tax calculator →</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#999;">Available on Pro and Elite plans. 7-day free trial — no charge until day 8.</p>
  </td></tr>
  <tr><td style="background:#f0f0f6;border-radius:0 0 16px 16px;padding:20px 40px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#aaa;">PropDesk · propdesk.uk</p>
  </td></tr>
</table></td></tr></table>
</body></html>`;
}

function onboardingEmail3(email) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:#07001f;border-radius:16px 16px 0 0;padding:28px 40px;text-align:center;">
    <span style="font-size:20px;font-weight:900;color:#fff;letter-spacing:0.03em;">PROP<span style="color:rgba(255,255,255,0.4);">DESK</span></span>
  </td></tr>
  <tr><td style="background:#fff;padding:40px;">
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0a0020;">One rule could cost you your funded account ⚠️</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#666;line-height:1.6;">Every prop firm has inactivity rules. Miss a trading day and you could lose your funded account — not because you blew the drawdown, but because you forgot to place a trade.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="background:#fff8e6;border:1px solid #f59e0b;border-radius:12px;padding:20px 24px;">
          <div style="font-size:13px;font-weight:700;color:#f59e0b;margin-bottom:10px;">⚠ Example: FTMO inactivity rule</div>
          <div style="font-size:14px;color:#555;line-height:1.7;">You must place at least 1 trade every 10 calendar days. Miss this and your account can be closed — even if you're profitable.</div>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 20px;font-size:15px;color:#666;line-height:1.6;">PropDesk tracks your last trade date for every account and warns you before the deadline — with firm-specific rules for 16+ prop firms built in.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="https://propdesk.uk/app.html" style="display:inline-block;background:#6e45ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:12px;">Check your inactivity status →</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#999;">Questions? Reply to this email anytime.</p>
  </td></tr>
  <tr><td style="background:#f0f0f6;border-radius:0 0 16px 16px;padding:20px 40px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#aaa;">PropDesk · propdesk.uk</p>
  </td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── EMAIL API ENDPOINTS ──────────────────────────────────────

// Send welcome email (called after signup webhook or directly)
app.post('/email/welcome', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  await sendEmail({ to: email, subject: 'Welcome to PropDesk 🚀', html: welcomeEmail(email) });
  res.json({ sent: true });
});

// Send onboarding sequence (day 3 and day 7)
app.post('/email/onboarding', async (req, res) => {
  const { email, day } = req.body;
  if (!email || !day) return res.status(400).json({ error: 'Missing email or day' });
  let subject, html;
  if (day === 2) { subject = 'Are you paying too much tax on your prop payouts?'; html = onboardingEmail2(email); }
  else if (day === 3) { subject = 'One rule could cost you your funded account ⚠️'; html = onboardingEmail3(email); }
  else return res.status(400).json({ error: 'Invalid day — use 2 or 3' });
  await sendEmail({ to: email, subject, html });
  res.json({ sent: true });
});

app.listen(PORT, () => {
  console.log(`PropDesk backend listening on port ${PORT}`);
});
