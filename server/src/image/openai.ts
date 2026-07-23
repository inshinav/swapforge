// OpenAI images/edits провайдер слайдов. Реализация — задача P1.4 (PLAN.md);
// до неё селектор честно падает, а не молчит.
import type { ImageProvider } from './provider';

export const openaiImageProvider: ImageProvider = {
  name: () => 'openai',
  async edit() {
    throw new Error('openai ImageProvider ещё не реализован (P1.4) — используй CAROUSEL_IMAGE_PROVIDER=mock');
  },
};
