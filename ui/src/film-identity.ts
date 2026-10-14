import type { FilmStock } from './library';

/** The source match controls the revision, not the short/translated menu name. */
export function photoIdentity(stock: FilmStock | undefined, fileName: string, exactSource: boolean) {
  const name = stock?.name || fileName.replace(/\.(cube|xmp)$/i, '')
    .replace(/[^\x20-\x7e]|[;=]/g, ' ').trim().slice(0, 64) || 'Custom Film';
  return { name, revision: exactSource && stock ? stock.recipeVersion || '120-L1' : 'Custom-1' };
}
