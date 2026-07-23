// Детерминированный мок-провайдер: юнит-тесты и дев-E2E без трат на API
// (CAROUSEL_IMAGE_PROVIDER=mock). Ничего не пишет на диск, сеть не трогает.
import type { ImageEditRequest, ImageEditResult, ImageProvider } from './provider';

/** 1×1 непрозрачный PNG — валидный вход для ffmpeg-финализации. */
const PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Промт с этим маркером имитирует модерацию (тесты лестницы смягчения). */
export const MOCK_MODERATION_MARKER = '[[mock-moderation]]';

export const mockImageProvider: ImageProvider = {
  name: () => 'mock',
  async edit(req: ImageEditRequest): Promise<ImageEditResult> {
    if (req.prompt.includes(MOCK_MODERATION_MARKER)) {
      return { b64: '', model: 'mock-image-1', tokensIn: 0, tokensOut: 0, moderated: true };
    }
    return { b64: PIXEL_PNG_B64, model: 'mock-image-1', tokensIn: 100, tokensOut: 4160 };
  },
};
