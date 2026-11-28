// SPDX-License-Identifier: GPL-2.0-only
/** Host-only limits for a build with the Modern theme: 99 % of the largest file (81,000,780 bytes; decoded 110,600,932) a camera
 * took during the theme's development; a larger one was refused. The exact hardware threshold has not been established, so
 * these are not raised on the strength of the ICONBIN / flash capacity alone.
 */
import {FirmwareError} from '../../../types';
export const UI_SKIN_SIZE_BUDGET={fileBytes:80_190_772,decodedBytes:109_494_922} as const;
export function assertUiSkinSizeBudget(sizes:{fileBytes?:number;decodedBytes?:number},features:{modernTheme?:boolean}):void {
 if(!features.modernTheme)return;
 for(const key of ['fileBytes','decodedBytes']as const){
  const actual=sizes[key];if(actual===undefined)continue;
  if(!Number.isSafeInteger(actual)||actual<0||actual>UI_SKIN_SIZE_BUDGET[key])throw new FirmwareError('ui-skin-size-limit',`Modern theme firmware ${key} ${actual} exceeds the checked budget ${UI_SKIN_SIZE_BUDGET[key]}`);
 }
}
