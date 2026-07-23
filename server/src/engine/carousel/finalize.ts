// Финализация слайда (SPEC §2/§6): raw PNG провайдера → 1080×1350 (4:5) / 1080×1080 (1:1),
// sRGB JPEG ≤4MB. Cover+центр-кроп покрывает и негибкие модели (1024×1536 → кроп до 4:5).
// Best-effort: провал финализации НЕ роняет слайд — экспорт falls back на raw.
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db';
import { run } from '../../ffmpeg';
import { carouselSlidesDir } from '../../storage';

export const FINAL_SIZES = { '4:5': { w: 1080, h: 1350 }, '1:1': { w: 1080, h: 1080 } } as const;

/** ffmpeg-фильтр: масштаб с покрытием + центр-кроп + лёгкое сенсорное зерно (P8, телефонность) + sRGB. */
export function finalizeFilter(aspect: keyof typeof FINAL_SIZES): string {
  const { w, h } = FINAL_SIZES[aspect];
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},noise=alls=5:allf=t,format=yuvj420p`;
}

/**
 * Довести raw-файл слайда до платформенного размера. Возвращает имя final-файла
 * или null (ffmpeg недоступен/упал — раздаём raw).
 */
export async function finalizeSlideFile(
  carouselId: string,
  slideId: string,
  aspect: keyof typeof FINAL_SIZES = '4:5',
): Promise<string | null> {
  const db = getDb();
  const slide = db
    .prepare(`SELECT file FROM carousel_slides WHERE id=? AND carousel_id=?`)
    .get(slideId, carouselId) as { file: string | null } | undefined;
  if (!slide?.file) return null;
  const dir = carouselSlidesDir(carouselId);
  const src = path.join(dir, slide.file);
  if (!fs.existsSync(src)) return null;
  const finalName = slide.file.replace(/\.png$/i, '') + '_final.jpg';
  const dest = path.join(dir, finalName);
  try {
    await run('ffmpeg', ['-y', '-i', src, '-vf', finalizeFilter(aspect), '-frames:v', '1', '-q:v', '2', dest], 60_000);
    db.prepare(`UPDATE carousel_slides SET final_file=?, updated_at=datetime('now') WHERE id=?`).run(
      finalName,
      slideId,
    );
    return finalName;
  } catch (e) {
    console.warn(
      `[carousel-finalize] слайд ${slideId}: финализация не удалась (${e instanceof Error ? e.message.slice(0, 120) : e}) — экспорт отдаст raw`,
    );
    fs.rmSync(dest, { force: true });
    return null;
  }
}
