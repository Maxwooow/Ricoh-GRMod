/** Prefer the complete model name; compact aliases also support legacy slots. */
export function filmSlotName(stock: { cameraName: string; compactName?: string; shortName: string }, capacity: number): string {
  for (const name of [stock.cameraName, stock.compactName, stock.cameraName.replaceAll(' ', ''), stock.shortName])
    if (name && name.length <= capacity) return name;
  throw new Error('相机名称长度不足，无法保留胶片型号');
}
