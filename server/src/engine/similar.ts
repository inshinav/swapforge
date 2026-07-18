import { getDb } from '../db';

export interface SimilarExample {
  projectId: string;
  title: string;
  tags: string[];
  videoPrompt: string;
  feedbackNote: string;
  score: number;
}

function norm(tags: string[]): Set<string> {
  return new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Few-shot ретрив: 2–3 наиболее похожих проекта (по overlap тегов анализа),
 * у которых есть версия промта с фидбеком «сработало».
 * СТРОГО в пределах одного пользователя: удачный промт несёт описание внешности
 * его модели — межтенантный ретрив был бы утечкой чужих образов в чужой контекст.
 */
export function findSimilarWorked(
  userId: string,
  excludeId: string,
  tags: string[],
  limit = 3,
): SimilarExample[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.tags_json, f.version, f.notes,
              (SELECT text FROM prompts pr
                 WHERE pr.project_id = p.id AND pr.kind = 'video' AND pr.version = f.version
                 LIMIT 1) AS video_prompt
         FROM projects p
         JOIN feedback f ON f.project_id = p.id AND f.worked = 1
        WHERE p.user_id = ? AND p.id != ? AND p.tags_json IS NOT NULL
        ORDER BY f.created_at DESC`,
    )
    .all(userId, excludeId) as Array<{
    id: string;
    title: string;
    tags_json: string;
    version: number;
    notes: string;
    video_prompt: string | null;
  }>;

  const mine = norm(tags);
  const seen = new Set<string>();
  const scored: SimilarExample[] = [];
  for (const r of rows) {
    if (seen.has(r.id) || !r.video_prompt) continue;
    seen.add(r.id); // одна (свежайшая сработавшая) версия на проект
    let theirTags: string[] = [];
    try {
      theirTags = JSON.parse(r.tags_json) as string[];
    } catch {
      continue;
    }
    const score = jaccard(mine, norm(theirTags));
    if (score >= 0.12) {
      scored.push({
        projectId: r.id,
        title: r.title,
        tags: theirTags,
        videoPrompt: r.video_prompt,
        feedbackNote: r.notes,
        score,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
