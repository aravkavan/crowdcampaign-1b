// The offline estimate: a simple, transparent keyword heuristic used when no AI key
// is configured. It is NOT AI, and the app labels it that way everywhere. It exists so
// the whole shortlist flow can be tried and tested without a key or an internet connection.

const STOPWORDS = new Set(
  `a about after again all also an and any are as at be been being but by can could did do does for from
   get got had has have how if in into is it its just like make many more most much must need no not now
   of on one only or other our out over really so some such than that the their them then there these they
   this those through to too up us use very was way we were what when where which while who why will with
   would you your`.split(/\s+/),
);

const CHANNEL_WORDS = [
  'tiktok', 'instagram', 'reels', 'stories', 'youtube', 'social', 'video', 'videos', 'creator', 'creators',
  'influencer', 'influencers', 'hashtag', 'challenge', 'contest', 'giveaway', 'ugc', 'ambassador', 'ambassadors',
  'referral', 'partner', 'partners', 'partnership', 'collab', 'pop-up', 'popup', 'event', 'events', 'sampling',
  'samples', 'campus', 'community', 'club', 'clubs', 'playlist', 'newsletter', 'email', 'qr', 'filter',
  'livestream', 'podcast', 'meme', 'memes', 'limited', 'exclusive', 'loyalty', 'rewards', 'stickers', 'posters',
];

const PLAN_WORDS = ['week', 'weeks', 'month', 'budget', 'cost', 'costs', 'phase', 'step', 'timeline', 'measure', 'track', 'goal'];

function words(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+(?:[-'][a-z0-9]+)*/g) ?? [];
}

function keyTerms(list) {
  return new Set(list.filter((w) => w.length > 3 && !STOPWORDS.has(w)));
}

const clamp = (n) => Math.min(10, Math.max(1, Math.round(n)));

export function scoreOffline(campaign, idea) {
  const briefTerms = keyTerms(words(`${campaign.title} ${campaign.brief}`));
  const ideaText = `${idea.title} ${idea.content}`;
  const ideaWords = words(ideaText);
  const ideaTerms = keyTerms(ideaWords);

  const shared = [...briefTerms].filter((w) => ideaTerms.has(w)).length; // on-brief vocabulary
  const fresh = [...ideaTerms].filter((w) => !briefTerms.has(w)).length; // new vocabulary
  const channels = CHANNEL_WORDS.filter((w) => ideaWords.includes(w)).length;
  const planning = PLAN_WORDS.filter((w) => ideaWords.includes(w)).length + (ideaText.includes('$') ? 1 : 0);
  const length = ideaWords.length;

  const relevance = clamp(2 + (8 * Math.min(shared, 10)) / 10);
  const creativity = clamp(2 + Math.min(fresh, 36) / 6 - (length < 30 ? 2 : 0));
  const detail = length < 25 ? 2 : length < 60 ? 5 : length <= 400 ? 7 : 6;
  const feasibility = clamp(detail + Math.min(planning, 3));
  const marketing_potential = clamp(3 + Math.min(channels, 7));

  return {
    creativity,
    relevance,
    feasibility,
    marketing_potential,
    summary:
      `Keyword check: shares ${shared} key term${shared === 1 ? '' : 's'} with the brief, ` +
      `is ${length} words long and mentions ${channels} marketing channel${channels === 1 ? '' : 's'}.`,
  };
}
