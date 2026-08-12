/* The free downloads, and which MailerLite group delivers each one.

   Three separate entry points need this map — the website form (api/newsletter.mjs), the
   confirmation link (api/newsletter-confirm.mjs) and Facebook Lead Ads (api/meta-leads.mjs)
   — so it lives here rather than in whichever one happened to need it first. One list, one
   place to add the next magnet.

   Keep the keys in sync with the `data-magnet` attributes in the forms: the /get/* landing
   pages, newsletter.html, and the capture card on every blog post.

   `env` names the Vercel variable holding that magnet's MailerLite group ID. Anything unset
   falls back to MAILERLITE_GROUP_ID, so a half-finished MailerLite setup degrades to
   "everyone gets the eBook" rather than to lost subscribers. */

export const MAGNETS = {
  ebook: {
    label: 'Build a Retirement Plan You Can Question',
    env: 'MAILERLITE_GROUP_ID',
  },
  checklist: {
    label: 'The retirement input checklist',
    env: 'MAILERLITE_GROUP_ID_CHECKLIST',
  },
  questions: {
    label: '50+ questions to ask your retirement plan',
    env: 'MAILERLITE_GROUP_ID_QUESTIONS',
  },
  abroad: {
    label: 'The cross-border retirement guide',
    env: 'MAILERLITE_GROUP_ID_ABROAD',
  },
};

export const DEFAULT_MAGNET = 'ebook';

/* Unrecognised values fall back rather than erroring: a visitor running a cached copy of
   main.js from before a magnet was renamed still gets a working signup. */
export function resolveMagnet(raw) {
  return typeof raw === 'string' && MAGNETS[raw] ? raw : DEFAULT_MAGNET;
}

export function magnetLabel(key) {
  return (MAGNETS[key] || MAGNETS[DEFAULT_MAGNET]).label;
}

export function magnetGroupId(key) {
  const entry = MAGNETS[key] || MAGNETS[DEFAULT_MAGNET];
  return process.env[entry.env] || process.env.MAILERLITE_GROUP_ID;
}
