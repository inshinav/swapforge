// Virality-фильтр (SPEC §3): детерминированный, до vision. Чистые функции — без I/O.

export interface MinedPost {
  url: string;
  type: 'carousel' | 'photo' | 'video' | 'unknown';
  likes: number;
  comments: number;
  /** ISO-время публикации. */
  timestamp: string;
  /** Подписчики автора на момент скрейпа (profile-scrape, SPEC §3). */
  ownerFollowers: number;
  author: string;
  thumbUrl: string | null;
  /** Число слайдов, если актор его отдал. */
  slideCount: number | null;
}

export interface ViralityOpts {
  erMin?: number;
  likesMin?: number;
  maxAgeDays?: number;
  topN?: number;
  /** Инъекция времени для детерминированных тестов. */
  nowMs?: number;
}

export function engagementRate(p: MinedPost): number {
  if (!p.ownerFollowers || p.ownerFollowers <= 0) return 0;
  return (p.likes + p.comments) / p.ownerFollowers;
}

/** Карусели/фото; ER ≥ порога; likes ≥ минимума; свежесть; топ-N по ER. */
export function viralityFilter(posts: MinedPost[], opts: ViralityOpts = {}): MinedPost[] {
  const erMin = opts.erMin ?? 0.03;
  const likesMin = opts.likesMin ?? 2000;
  const maxAgeMs = (opts.maxAgeDays ?? 90) * 24 * 3_600_000;
  const topN = opts.topN ?? 20;
  const now = opts.nowMs ?? Date.now();
  return posts
    .filter((p) => p.type === 'carousel' || p.type === 'photo')
    .filter((p) => p.likes >= likesMin)
    .filter((p) => {
      const t = Date.parse(p.timestamp);
      return Number.isFinite(t) && now - t <= maxAgeMs;
    })
    .filter((p) => engagementRate(p) >= erMin)
    .sort((a, b) => engagementRate(b) - engagementRate(a))
    .slice(0, topN);
}

/**
 * Нормализация выдачи apify/instagram-profile-scraper: профиль с followersCount и
 * latestPosts[]. Чужие/битые элементы тихо пропускаются (скрейп — грязные данные).
 */
export function normalizeProfileItems(items: unknown[]): MinedPost[] {
  const out: MinedPost[] = [];
  for (const raw of items) {
    const profile = raw as {
      username?: string;
      followersCount?: number;
      latestPosts?: Array<{
        type?: string;
        url?: string;
        likesCount?: number;
        commentsCount?: number;
        timestamp?: string;
        displayUrl?: string;
        childPosts?: unknown[];
      }>;
    };
    const followers = Number(profile.followersCount ?? 0);
    for (const post of profile.latestPosts ?? []) {
      if (!post?.url || !post.timestamp) continue;
      const type =
        post.type === 'Sidecar' ? 'carousel' : post.type === 'Image' ? 'photo' : post.type === 'Video' ? 'video' : 'unknown';
      out.push({
        url: post.url,
        type,
        likes: Number(post.likesCount ?? 0),
        comments: Number(post.commentsCount ?? 0),
        timestamp: post.timestamp,
        ownerFollowers: followers,
        author: profile.username ?? '',
        thumbUrl: post.displayUrl ?? null,
        slideCount: Array.isArray(post.childPosts) && post.childPosts.length > 0 ? post.childPosts.length : null,
      });
    }
  }
  return out;
}
