import type { PresetResult } from '@grmod/core';
import { sha256Hex } from './host';
declare const __GRMOD_INSTALLED_FILMS__: Record<'gr3x' | 'gr4', string[]>;
const installed = typeof __GRMOD_INSTALLED_FILMS__ === 'undefined' ? {gr3x:[],gr4:[]} : __GRMOD_INSTALLED_FILMS__;

export type Family = 'gr3x' | 'gr4';
export interface FilmStock {
  id: string; name: string; cameraName: string; compactName?: string; shortName: string; brand: string; category: string;
  icon: string; label: string; packaging: string; packagingUrl: string;
  status: 'ready' | 'pending'; reason?: string; note: string;
  cube?: string; cubeSha256?: string;
  /** Revision of the catalog's selected source; actual fitted bytes also get a fingerprint. */
  recipeVersion?: string;
  testedGr3x: boolean; testedGr4: boolean;
  source?: { provider: string; url: string; license: string; note?: string };
  sources: { source: string; name: string; page: string; status: string }[];
  fits?: Partial<Record<Family, { meanDE: number; p95DE: number; sha256: string }>>;
}
export interface FilmCatalog { schema: 1; version: string; count: number; stocks: FilmStock[] }
export const libraryAsset = (path: string): string => '/film-library/' + path;
let catalogPromise: Promise<FilmCatalog> | undefined;
export function loadFilmCatalog(): Promise<FilmCatalog> {
  return catalogPromise ??= fetch(libraryAsset('catalog.json')).then(async r => {
    if (!r.ok) throw new Error('无法读取本地胶片库');
    const c: FilmCatalog = await r.json();
    if (c.schema !== 1 || c.count !== 120 || c.stocks.length !== c.count || new Set(c.stocks.map(s => s.id)).size !== c.count)
      throw new Error('胶片库目录校验失败');
    return {...c, stocks:c.stocks.map(s => {
      const fits = {...s.fits};
      for (const family of ['gr3x','gr4'] as const) if (!installed[family].includes(s.id)) delete fits[family];
      return {...s, fits, ...(!Object.keys(fits).length && s.status === 'ready'
        ? {status:'pending' as const,reason:'此电脑尚未安装该源方案。可导入自己持有的 CUBE，并使用对应名称和图标。'} : {})};
    })};
  }).catch(e => { catalogPromise = undefined; throw e; });
}
const fits = new Map<string, Promise<{ result: PresetResult; firmwareSha256: string }>>();
export function loadFilmFit(s: FilmStock, family: Family): Promise<{ result: PresetResult; firmwareSha256: string }> {
  const key = s.id + '-' + family;
  let value = fits.get(key);
  if (!value) {
    value = (async () => {
      const expected = s.fits?.[family];
      if (s.status !== 'ready' || !expected) throw new Error(s.reason || '该方案尚未完成本机型的转换');
      const response = await fetch(libraryAsset('fits/' + key + '.json'));
      if (!response.ok) throw new Error('缺少本机型的胶片参数');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (await sha256Hex(bytes) !== expected.sha256) throw new Error('胶片参数文件校验失败');
      const doc = JSON.parse(new TextDecoder().decode(bytes));
      if (doc.id !== s.id || doc.family !== family || doc.sourceSha256 !== s.cubeSha256)
        throw new Error('胶片参数与源文件不匹配');
      const r = doc.result;
      const result: PresetResult = { ...r, params: { M1: r.params.M1, ck: r.params.ck.map((c: number[]) => Float64Array.from(c)) },
        matrixQ13: Int16Array.from(r.matrixQ13), curves: r.curves.map((c: number[]) => Uint16Array.from(c)) };
      return { result, firmwareSha256: doc.firmwareSha256 };
    })();
    fits.set(key, value);
    value.catch(() => fits.delete(key));
  }
  return value;
}
export async function loadFilmSource(s: FilmStock): Promise<string> {
  if (!s.cube || !s.cubeSha256) throw new Error(s.reason || '尚未取得可用方案');
  const response = await fetch(libraryAsset(s.cube));
  if (!response.ok || !response.body) throw new Error('无法读取胶片源文件');
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (await sha256Hex(bytes) !== s.cubeSha256) throw new Error('胶片源文件校验失败');
  return new TextDecoder().decode(bytes);
}
export async function filmIconData(s: FilmStock): Promise<string> {
  const response = await fetch(libraryAsset(s.label));
  if (!response.ok) throw new Error('无法读取胶片图标');
  const bytes = new Uint8Array(await response.arrayBuffer());
  return 'data:image/png;base64,' + btoa(String.fromCharCode(...bytes));
}
