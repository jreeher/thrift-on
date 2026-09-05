require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');

const adminRouter = require('./routes/admin');
const apiRouter = require('./routes/api');
const storefrontRouter = require('./routes/storefront');
const webhooksRouter = require('./routes/webhooks');
const staffRouter = require('./routes/staff');
const { releaseExpiredCarts } = require('./jobs/release-carts');
const { recalculatePrices } = require('./jobs/markdown');
const { purgePhotos } = require('./jobs/purge-photos');
const { issueConsignmentPayouts } = require('./jobs/issue-consignment-payouts');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Railway terminates TLS and proxies every request — without this, req.ip would be the
// proxy's own address for every visitor, which breaks any per-IP logic (e.g. the store
// credit lookup rate limit in routes/storefront.js).
app.set('trust proxy', true);

app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.static(path.join(__dirname, 'public')));

// Mounted first and before any express.json()/urlencoded() parser: the Stripe webhook
// route needs the exact raw request body to verify its signature, and its own router
// applies express.raw() only to itself (Section 9).
app.use('/webhooks', webhooksRouter);

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get('/login', (req, res) => {
  res.render('login', { error: null, next: req.query.next || '/admin/review' });
});

app.post(
  '/login',
  express.urlencoded({ extended: false }),
  asyncHandler(async (req, res) => {
    const { password, next: nextUrl } = req.body;

    if (!process.env.STAFF_PASSWORD) {
      return res.render('login', {
        error: 'STAFF_PASSWORD is not configured on the server.',
        next: nextUrl || '/admin/review'
      });
    }

    if (password !== process.env.STAFF_PASSWORD) {
      return res.render('login', { error: 'Incorrect password.', next: nextUrl || '/admin/review' });
    }

    res.cookie('staff_session', 'authenticated', {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000 // 12 hours
    });

    res.redirect(nextUrl && nextUrl.startsWith('/') ? nextUrl : '/admin/review');
  })
);

app.post('/logout', (req, res) => {
  res.clearCookie('staff_session');
  res.redirect('/login');
});

app.use('/admin', adminRouter);
app.use('/api', apiRouter);
app.use('/staff', staffRouter);

app.use('/', storefrontRouter);

app.use((req, res) => {
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

// Releases abandoned cart reservations back to 'active' every 5 minutes (Section 9/10).
cron.schedule('*/5 * * * *', () => {
  releaseExpiredCarts().catch((err) => console.error('release-carts job failed:', err));
});

// Recomputes markdown prices and expires items past week 5, daily at 03:00 (Section 10).
cron.schedule('0 3 * * *', () => {
  recalculatePrices().catch((err) => console.error('markdown job failed:', err));
});

// Purges photos for items past their 7-day retention in a terminal state, daily at 03:30.
cron.schedule('30 3 * * *', () => {
  purgePhotos().catch((err) => console.error('purge-photos job failed:', err));
});

// Issues consignment payouts for items whose 7-day return window has fully elapsed,
// daily at 04:00.
cron.schedule('0 4 * * *', () => {
  issueConsignmentPayouts().catch((err) => console.error('issue-consignment-payouts job failed:', err));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OTS server listening on port ${PORT}`);
});
