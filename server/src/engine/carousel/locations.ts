// LocationPack'и: паки — ДАННЫЕ (ts-константа + zod-валидация), движок про Майами не знает.
// Новый пак = новая константа в PACKS, ноль правок движка (SPEC §2).
import { z } from 'zod';

export const LocationSceneZ = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Название для UI (RU). */
  name: z.string().min(1),
  /** EN-блок промта: место + свет + время суток + фактура. */
  promptBlock: z.string().min(20),
  formats: z.array(z.enum(['4:5', '1:1'])).min(1),
});
export type LocationScene = z.infer<typeof LocationSceneZ>;

export const LocationPackZ = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  scenes: z.array(LocationSceneZ).min(6),
});
export type LocationPack = z.infer<typeof LocationPackZ>;

const BOTH: Array<'4:5' | '1:1'> = ['4:5', '1:1'];

export const MIAMI_PACK: LocationPack = {
  id: 'miami',
  name: 'Майами',
  scenes: [
    {
      id: 'south-beach-sand',
      name: 'Песок South Beach',
      promptBlock:
        'On the white sand of South Beach Miami next to a pastel art-deco lifeguard tower, ' +
        'late morning sun, turquoise ocean and a few beachgoers blurred in the background, ' +
        'fine sand texture on skin and feet.',
      formats: BOTH,
    },
    {
      id: 'ocean-drive-neon',
      name: 'Неон Ocean Drive',
      promptBlock:
        'On the sidewalk of Ocean Drive Miami at night, glowing pink and cyan neon signs of ' +
        'art-deco hotels, wet asphalt reflections, warm street lamps mixing with neon, ' +
        'passing cars leaving light streaks in the background.',
      formats: BOTH,
    },
    {
      id: 'wynwood-murals',
      name: 'Муралы Wynwood',
      promptBlock:
        'In front of a huge colorful street-art mural in Wynwood Walls Miami, bright midday ' +
        'sun with hard shadows, saturated spray-paint colors, rough painted concrete texture, ' +
        'gravel and asphalt underfoot.',
      formats: BOTH,
    },
    {
      id: 'brickell-rooftop-pool',
      name: 'Руфтоп-бассейн Brickell',
      promptBlock:
        'At a rooftop infinity pool in Brickell Miami, glass skyscrapers behind, late afternoon ' +
        'sun glinting off towers, ripples of clear pool water, wet tiles and sun loungers.',
      formats: BOTH,
    },
    {
      id: 'marina-yacht',
      name: 'Марина и яхта',
      promptBlock:
        'On the teak deck of a white yacht docked in a Miami marina, masts and hulls bobbing ' +
        'behind, bright clear noon light, sparkling water, polished chrome rails and rope textures.',
      formats: BOTH,
    },
    {
      id: 'palm-street',
      name: 'Улица с пальмами',
      promptBlock:
        'On a quiet residential Miami street lined with tall royal palms, pastel houses and ' +
        'trimmed lawns, soft morning light through palm fronds, long shadows on warm asphalt.',
      formats: BOTH,
    },
    {
      id: 'boardwalk-golden-hour',
      name: 'Променад на закате',
      promptBlock:
        'On the wooden beach boardwalk of Miami Beach at golden hour, low warm sun flaring into ' +
        'the lens, dune grass and sea oats beside the path, honey-colored light on skin, ocean haze.',
      formats: BOTH,
    },
    {
      id: 'hotel-lobby',
      name: 'Лобби люкс-отеля',
      promptBlock:
        'In the lobby of a luxury Miami Beach hotel, marble floors, brass and velvet furniture, ' +
        'warm chandelier glow mixed with daylight from tall windows, soft reflections on polished stone.',
      formats: BOTH,
    },
    {
      id: 'open-air-cafe',
      name: 'Летнее кафе',
      promptBlock:
        'At a small open-air cafe table on a shaded Miami sidewalk, iced coffee and pastry on the ' +
        'table, dappled light through an umbrella, background of passersby softly out of focus.',
      formats: BOTH,
    },
    {
      id: 'convertible-causeway',
      name: 'Кабриолет на дамбе',
      promptBlock:
        'In the passenger seat of a convertible driving across a Miami causeway, wind in the hair, ' +
        'bright blue sky and bay water on both sides, sun glare on the windshield, motion in the background.',
      formats: BOTH,
    },
    {
      id: 'gym-interior',
      name: 'Зал',
      promptBlock:
        'Inside a modern Miami gym with floor-to-ceiling windows, racks of dumbbells and cable ' +
        'machines, cool daylight mixed with warm interior spots, rubber floor texture, light sweat sheen.',
      formats: BOTH,
    },
    {
      id: 'penthouse-sunset',
      name: 'Балкон пентхауса',
      promptBlock:
        'On a penthouse balcony above Miami at sunset, orange-to-violet sky over Biscayne Bay, ' +
        'city lights starting to glow below, glass railing reflections, warm rim light on hair.',
      formats: BOTH,
    },
  ],
};

const PACKS: Record<string, LocationPack> = { [MIAMI_PACK.id]: MIAMI_PACK };

export function getLocationPack(id: string): LocationPack | null {
  return PACKS[id] ?? null;
}

export function getScene(packId: string, sceneId: string): LocationScene | null {
  return getLocationPack(packId)?.scenes.find((s) => s.id === sceneId) ?? null;
}

export function listLocationPacks(): LocationPack[] {
  return Object.values(PACKS);
}
