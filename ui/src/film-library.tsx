import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresetResult, SlotId } from '@grmod/core';
import { Ico } from './components';
import { PhotoCompare } from './pages';
import { applyLibraryFilm, setPage, useStore } from './store';
import { libraryAsset, loadFilmCatalog, loadFilmFit } from './library';
import type { FilmCatalog, FilmStock } from './library';
import { filmSlotName } from './film-names';

const TYPES = ['彩色负片', '彩色反转片', '黑白负片', '即时成像', '电影彩色负片', '电影彩色反转片', '电影黑白负片', '电影打印片'];
export function FilmLibraryPage() {
  const model = useStore(s => s.model), info = useStore(s => s.info), slots = useStore(s => s.slots);
  const lang = useStore(s => s.lang);
  const busy = useStore(s => !!s.busy || s.fwBusy);
  const family = model === 'GR3X_HDF' ? 'gr3x' : 'gr4';
  const [catalog, setCatalog] = useState<FilmCatalog>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState(''), [brand, setBrand] = useState(''), [type, setType] = useState('');
  const [readyOnly, setReadyOnly] = useState(false);
  const [selectedId, setSelectedId] = useState('fujifilm-provia-100f');
  const [target, setTarget] = useState<SlotId>('CY');
  const [fit, setFit] = useState<PresetResult>();
  const [fitError, setFitError] = useState('');
  const cubeInput = useRef<HTMLInputElement>(null);
  const detail = useRef<HTMLElement>(null);
  useEffect(() => { void loadFilmCatalog().then(setCatalog).catch(e => setError(String(e.message || e))); }, []);
  const selected = catalog?.stocks.find(s => s.id === selectedId);
  const available = (s: FilmStock) => s.status === 'ready' && !!s.fits?.[family];
  const canChoose = !!info && info.family === family && info.capabilities.presets && !info.bridge && model !== 'MONO';
  const choices = info?.family === family ? info.slots : [];
  useEffect(() => { if (!choices.some(s => s.id === target)) setTarget('CY'); }, [family, info, target]);
  useEffect(() => {
    let cancelled = false;
    detail.current?.scrollTo({ top: 0 });
    setFit(undefined); setFitError('');
    if (selected && available(selected)) void loadFilmFit(selected, family)
      .then(f => { if (!cancelled) setFit(f.result); })
      .catch(e => { if (!cancelled) setFitError(String(e.message || e)); });
    return () => { cancelled = true; };
  }, [selected, family]);
  const filtered = useMemo(() => (catalog?.stocks || []).filter(s =>
    (!query.trim() || (s.name + ' ' + s.sources.map(e => e.name).join(' ')).toLowerCase().includes(query.trim().toLowerCase())) &&
    (!brand || s.brand === brand) && (!type || s.category === type) && (!readyOnly || available(s)))
    .sort((a,b) => TYPES.indexOf(a.category)-TYPES.indexOf(b.category) || a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name, undefined, { numeric:true })),
    [catalog, query, brand, type, readyOnly, family]);
  const chosen = (id: string): string[] => choices.filter(s => slots[s.id].preset?.libraryId === id).map(s => s.defaultName);
  const readyCount = catalog?.stocks.filter(available).length || 0;
  const existingName = slots[target]?.preset ? slots[target].names.en || slots[target].preset?.fileName : '';
  return <section className="page film-library-page">
    <header className="page-head"><span className="page-icon">{Ico.archive}</span><h1>胶片库</h1>
      <span className="chip">{catalog?.count || 120} 款</span><span className="grow" />
      <button className="btn" onClick={() => setPage('ic')}>查看已选方案</button>
    </header>
    <p className="library-intro">{family === 'gr3x' ? 'GR IIIx HDF 1.60 · 9 个独立胶片槽位' : 'GR IV 1.11 · 9 个独立胶片槽位'}
      <span>{readyCount} 款可选 · {catalog ? catalog.count-readyCount : '…'} 款待补充</span></p>
    {family === 'gr3x' && <p className="small muted">打包后，拍摄的 JPG 会自动记录完整胶片名称、方案版本及参数指纹。RAW 保留现有处理方式。</p>}
    <div className="library-filters">
      <input className="input" type="search" aria-label="搜索胶片" placeholder="搜索胶片名称…" value={query} onChange={e=>setQuery(e.target.value)} />
      <select className="input" aria-label="胶片品牌" value={brand} onChange={e=>setBrand(e.target.value)}><option value="">全部品牌</option>{[...new Set(catalog?.stocks.map(s=>s.brand))].sort().map(b=><option key={b}>{b}</option>)}</select>
      <select className="input" aria-label="胶片类型" value={type} onChange={e=>setType(e.target.value)}><option value="">全部类型</option>{TYPES.map(t=><option key={t}>{t}</option>)}</select>
      <label className="library-check"><input type="checkbox" checked={readyOnly} onChange={e=>setReadyOnly(e.target.checked)} />只看可选</label>
      <button className="btn small" onClick={()=>{setQuery('');setBrand('');setType('');setReadyOnly(false);}}>重置</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="library-body">
      <div className="library-list" aria-label="胶片方案目录"><p className="small muted">显示 {filtered.length} / {catalog?.count || 120} 款 · 点击预览</p>
        <div className="library-grid">{filtered.map(s=><button key={s.id} className={`library-card ${selectedId===s.id?'selected':''}`} onClick={()=>setSelectedId(s.id)} aria-pressed={selectedId===s.id} aria-label={'预览 '+s.name}>
          <img src={libraryAsset(s.icon)} alt="" width="80" height="80" /><span className="library-brand">{s.brand}</span><b>{s.name.replace(s.brand+' ','')}</b><span className="small muted">{s.category}</span>
          <span className={`library-status ${chosen(s.id).length?'chosen':''}`}>{chosen(s.id).length?'已选入槽位':available(s)?'可选':'待补充源文件'}</span>
        </button>)}</div>
      </div>
      <aside ref={detail} className="library-detail" aria-label="胶片预览与选择">{selected && <>
        <div className="library-detail-head"><img src={libraryAsset(selected.icon)} width="64" height="64" alt={selected.name+' 图标'} /><div><h2>{selected.name}</h2><p className="small muted">{selected.category} · {selected.source?.provider || '待导入'} </p></div></div>
        {fit ? <div className="library-photo"><PhotoCompare params={fit.params}/></div> : <div className="library-no-preview">{fitError || (available(selected)?'正在载入预览…':selected.reason || '尚未取得可用源文件')}</div>}
        <p className="small muted">预览为本机型的拟合效果。{family==='gr3x' && selected.testedGr3x?'该源方案已有 IIIx 实拍记录。':'尚待相机实拍确认。'}</p>
        {family === 'gr3x' && <p className="small muted">JPG 记录：{selected.name} · {available(selected) ? selected.recipeVersion || '120-L1' : '导入后按自定义版本记录'}</p>}
        {fit && fit.p95DE>6 && <p className="library-notice">部分颜色与原方案差异较大，建议先对比预览，再刷机测试。</p>}
        <div className="library-apply">
          <label htmlFor="library-target">放入槽位</label>
          <select className="input" id="library-target" value={target} disabled={!canChoose||busy} onChange={e=>setTarget(e.target.value as SlotId)}>
            {choices.map(s=><option key={s.id} value={s.id}>{s.defaultName} · {slots[s.id].names.en || '未选择'}</option>)}
          </select>
          <p className="small muted">{existingName?'将替换：'+existingName:'选择后会同时载入色彩方案、名称和彩色图标。'}</p>
          {info?.slots.find(s=>s.id===target) && <p className="small muted">机内名称：{filmSlotName(selected,info.slots.find(s=>s.id===target)!.names[lang].capacity)}</p>}
          <button className="btn primary" disabled={busy || !canChoose || !fit || !available(selected)} onClick={()=>{void applyLibraryFilm(selected,target);}}>使用此方案与图标</button>
          {!available(selected) && <><input ref={cubeInput} type="file" accept=".cube" hidden onChange={e=>{const file=e.target.files?.[0];if(file)void applyLibraryFilm(selected,target,file);e.target.value='';}} />
            <button className="btn" disabled={busy||!canChoose} onClick={()=>cubeInput.current?.click()}>导入此款 CUBE 与图标</button></>}
          {!canChoose && <p className="small muted">{model==='MONO'?'彩色胶片库不适用于 GR IV Monochrome。':'先打开本机型支持的原厂固件，即可选择并打包。'}</p>}
        </div>
        <details className="library-source"><summary>方案来源与转换说明</summary>
          <p>{selected.note || '同一胶片的强弱、冷暖变体归为一款；当前采用默认版本。'}</p>
          {selected.source?.note && <p>{selected.source.note}</p>}
          {selected.source && <p>{selected.source.provider} · {selected.source.license}</p>}
          {fit && <p>拟合色差：平均 {fit.meanDE.toFixed(2)}，95% 分位 {fit.p95DE.toFixed(2)}。相机以矩阵与曲线近似 LUT，不包含颗粒、光晕等空间效果。</p>}
          <p>包装图标：{selected.packaging==='family-inspired'?'原包装待核，采用系列配色':selected.packaging==='related-family'?'参照同系列包装':'对应型号包装风格'}</p>
          {selected.sources.map((e,i)=><p key={i}><a href={e.page} target="_blank" rel="noreferrer">{e.name} · {e.source}</a></p>)}
        </details>
      </>}</aside>
    </div>
  </section>;
}
