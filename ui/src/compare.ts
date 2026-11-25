// What the "Inspect a firmware file" dialog shows about a summary, as rows, and the comparison of two
// summaries row by row. Pure (no React): the dialog lays the rows out and the tests read them.
import type { FirmwareSummary, LangCode } from '@grmod/core';
import { t } from './i18n';
import type { Key } from './i18n';
import { softText } from './store/features';
import { toneLabel } from './store/ratios';

/**
 * Every feature a FirmwareSummary can report, as label / on / detail, in the order the build summary
 * lists them (store/output.ts) and under the same names. `family` is the open firmware's: the
 * Monochrome unlock is the GR IIIx's "replica" looks there.
 */
export function featureRows(s: FirmwareSummary, family?: string): { label: string; on: boolean; detail?: string }[] {
  const bright = s.brightAuto === 'balanced' ? t('brightAutoBalanced') : s.brightAuto ? t('brightAutoBright') : '';
  return [
    { label: t('navSoft'), on: s.adjSoftFocus || (s.softFocus?.length ?? 0) > 0, detail: s.softFocus?.length ? softText(s.softFocus) : s.adjSoftFocus ? 'ADJ' : undefined },
    { label: t('navDate'), on: s.dateStamp },
    { label: t(family === 'gr3x' ? 'gr3xReplicaTitle' : 'navMono'), on: s.monoUnlock },
    { label: t('navBrightAuto'), on: !!s.brightAuto, detail: bright || undefined },
    { label: t('navFlash'), on: !!s.directFlash },
    { label: t('navHdr'), on: !!s.hdrGainMap },
    { label: t('navPreview'), on: !!s.exposurePreview },
    { label: t('navBattery'), on: !!s.batteryPercent },
    { label: t('navGrid'), on: !!s.customGrid || !!s.framing },
    { label: t('navShadow'), on: !!s.shadowLearn },
    { label: t('navGrain'), on: !!s.filmGrain },
    { label: t('navFlashTtl'), on: !!s.flashTtl },
    { label: t('navVideoAf'), on: !!s.videoAf },
    { label: t('navAwb'), on: !!s.awbLearn },
    { label: t('navMovieExp'), on: !!s.movieExposure },
    { label: t('navLamp'), on: !!s.constantLight },
    { label: t('navShift'), on: !!s.sensorShift },
    { label: t('navMovie4k'), on: !!s.movie4k },
    { label: t('navMovieSr'), on: !!s.movieSr },
    { label: t('navUnits'), on: !!s.distanceFeet, detail: s.distanceFeet ? t('unitsFeet') : undefined },
    { label: t('navAdjSlots'), on: !!s.adjSlots, detail: s.adjSlots ? String(s.adjSlots) : undefined },
    { label: t('ratioLive'), on: !!s.ratioShade, detail: s.ratioShade ? toneLabel(s.ratioShadeTone ?? 'dark') : undefined },
  ];
}

export const KIND: Record<FirmwareSummary['kind'], Key> = { official: 'inspectKindOfficial', modified: 'inspectKindModified', unknown: 'inspectKindUnknown' };
export interface CompareRow { label: string; a: string; b: string; differs: boolean }
const none = (): string => t('inspectNone');
const yesNo = (on: boolean, detail?: string): string => (on ? `${t('inspectYes')}${detail ? ` · ${detail}` : ''}` : t('inspectNo'));

/** One summary as label / value pairs; the same labels for any two summaries, so rows line up. */
function valueRows(s: FirmwareSummary, lang: LangCode, family?: string): { label: string; value: string }[] {
  const rows = [
    { label: t('inspectKind'), value: `${t(KIND[s.kind])}${s.kind === 'modified' ? ` · ${t('inspectChanged')} ${s.changedBytes}` : ''}` },
    { label: t('inspectVerified'), value: t(s.verified ? 'inspectYes' : 'inspectNo') },
  ];
  if (s.kind === 'unknown') return rows;
  for (const f of featureRows(s, family)) rows.push({ label: f.label, value: yesNo(f.on, f.detail) });
  rows.push(
    { label: t('inspectRatios'), value: s.ratios.length ? s.ratios.map((r) => `${r.name} (${r.ratio})`).join(' / ') : none() },
    { label: t('inspectExtras'), value: s.extraSlots.length ? s.extraSlots.map((x) => x.name).join(' / ') : none() },
    { label: t('inspectPictures'), value: s.shutdownPictures?.length ? s.shutdownPictures.map((p) => p.name).join(' / ') : none() },
    { label: t('inspectLayout'), value: s.lookLayout ? t('inspectLayoutValue', { n: s.lookLayout.hidden.length }) : none() },
  );
  for (const sl of s.slots) {
    const ch = [sl.colorChanged ? t('copyColor') : '', sl.iconChanged ? t('copyIcon') : '', sl.nameChanged ? t('copyName') : ''].filter(Boolean).join(' / ');
    rows.push({ label: `${t('inspectSlots')} · ${sl.id === 'CY' || sl.id === 'CG' ? t(('slotShort' + sl.id) as Key) : sl.id}`, value: `${sl.names[lang]}${ch ? ` · ${ch}` : ''}` });
  }
  return rows;
}

/** The two summaries side by side: every label of either, `differs` where the values are not the same ('-' where a side has no such row). */
export function compareRows(a: FirmwareSummary, b: FirmwareSummary, lang: LangCode, family?: string): CompareRow[] {
  const ra = valueRows(a, lang, family), rb = valueRows(b, lang, family);
  const labels: string[] = [];
  for (const r of [...ra, ...rb]) if (!labels.includes(r.label)) labels.push(r.label);
  return labels.map((label) => {
    const x = ra.find((r) => r.label === label)?.value ?? '-', y = rb.find((r) => r.label === label)?.value ?? '-';
    return { label, a: x, b: y, differs: x !== y };
  });
}
