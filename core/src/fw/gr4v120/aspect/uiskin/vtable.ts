// SPDX-License-Identifier: GPL-2.0-only
/** Build-time validation of A32 Itanium primary-vtable address points. No firmware code is added. */
import type {Patch} from '../build';
import {FirmwareError} from '../../../types';
import {adr,byRelease} from '../../target';
export const UI_NATIVE_VTABLE_TYPES:Readonly<Record<number,string>>={
  [adr(0x53ecf588)]:'10HeaderView',
  [adr(0x53ecf6d8)]:'10FooterView',
  [adr(0x53dd0e68)]:'17SubMenuController',
  [adr(0x53dd1a98)]:'15SvSetController',
  [adr(0x53dcd220)]:'19DriveModeController',
  [adr(0x53dd05e8)]:'22WhiteBalanceController',
  [adr(0x53dc9d88)]:'17AdjModeController',
  [adr(0x53dcb268)]:'16FnListController',
  [adr(0x53dcbe30)]:'22ImageControlController',
  [adr(0x53dc17a8)]:'24PlaybackSingleController',
  [adr(0x53dbf740)]:'18LiveViewController',
  [adr(0x53dc6af8)]:'17TopMenuController',
  [adr(0x53dcd3d0)]:'20SelectMenuController',
  [adr(0x53ece290)]:'6Canvas',
  [adr(0x53ece690)]:'14ScrollListView',
  [adr(0x53ecf3d0)]:'18SingleItemLineView',
  [adr(0x53ecec40)]:'8IconView',
  [adr(0x53ececd8)]:'17FunctionGuideView',
  [adr(0x53ece550)]:'8LineView',
  [adr(0x53ece708)]:'10StringView',
  [adr(0x53ece200)]:'9AsciiView',
  [adr(0x53ecf240)]:'15SpiritLevelView',
  [adr(0x53eceab8)]:'9FrameView',
  [adr(0x53ece4e0)]:'9GroupView',
  [adr(0x53ecf988)]:'13HistogramView',
};
// AdjModeController's constructor builds its vtable address with movw/movt (vtable-8: 1.20 0x53dc9d80, 1.21 0x53dcb418): the movw differs.
const CONSTRUCTOR_WORDS:Readonly<Record<number,readonly (readonly [number,number])[]>>={
  [adr(0x53ecf588)]:[[adr(0x535a245c),0xe59f1114],[adr(0x535a2578),adr(0x53ecf588)]],
  [adr(0x53ecf6d8)]:[[adr(0x535a2920),0xe59f30dc],[adr(0x535a2a04),adr(0x53ecf6d8)]],
  [adr(0x53dd0e68)]:[[adr(0x531e4428),0xe59f3078],[adr(0x531e44a8),adr(0x53dd0e68)]],
  [adr(0x53dd1a98)]:[[adr(0x531e5470),0xe59f3070],[adr(0x531e54e8),adr(0x53dd1a98)]],
  [adr(0x53dcd220)]:[[adr(0x531cf798),0xe59f3104],[adr(0x531cf8a4),adr(0x53dcd220)]],
  [adr(0x53dd05e8)]:[[adr(0x531deb14),0xe59f30a8],[adr(0x531debc4),adr(0x53dd05e8)]],
  [adr(0x53ece290)]:[[adr(0x53590f54),0xe59f3068],[adr(0x53590fc4),adr(0x53ece290)]],
  [adr(0x53ece690)]:[[adr(0x5359514c),0xe59f3194],[adr(0x535952e8),adr(0x53ece690)]],
  [adr(0x53ece550)]:[[adr(0x535933b0),0xe59f1048],[adr(0x53593400),adr(0x53ece550)]],
  [adr(0x53ecec40)]:[[adr(0x5359a094),0xe59f1054],[adr(0x5359a0f0),adr(0x53ecec40)]],
  [adr(0x53ece708)]:[[adr(0x53596040),0xe59f30b4],[adr(0x535960fc),adr(0x53ece708)]],
  [adr(0x53dc6af8)]:[[adr(0x531b57fc),0xe59f31b8],[adr(0x531b59bc),adr(0x53dc6af8)]],
  [adr(0x53dcd3d0)]:[[adr(0x531dcc9c),0xe59f30c8],[adr(0x531dcd6c),adr(0x53dcd3d0)]],
  [adr(0x53dc17a8)]:[[adr(0x531912d0),0xe59f310c],[adr(0x531913e4),adr(0x53dc17a8)]],
  [adr(0x53dc9d88)]:[[adr(0x531c19d8),byRelease({'1.20':0xe3093d80,'1.21':0xe30b3418})],[adr(0x531c19e0),0xe34533dc],[adr(0x531c19e8),0xe2832008],[adr(0x531c19f8),0xe5842000]],
  [adr(0x53dcb268)]:[[adr(0x531c3180),0xe59f209c],[adr(0x531c3224),adr(0x53dcb268)]],
  [adr(0x53dcbe30)]:[[adr(0x531c7300),0xe59f30a8],[adr(0x531c73b0),adr(0x53dcbe30)]],
  [adr(0x53ecf3d0)]:[[adr(0x535a0c80),0xe59f1064],[adr(0x535a0cec),adr(0x53ecf3d0)]],
  [adr(0x53ececd8)]:[[adr(0x5359a60c),0xe59f321c],[adr(0x5359a830),adr(0x53ececd8)]],
  [adr(0x53ece200)]:[[adr(0x53590370),0xe59f2098],[adr(0x53590410),adr(0x53ece200)]],
  [adr(0x53ece4e0)]:[[adr(0x535932e0),0xe59f1040],[adr(0x53593328),adr(0x53ece4e0)]],
  [adr(0x53ecf988)]:[[adr(0x535a5464),0xe59f105c],[adr(0x535a54c8),adr(0x53ecf988)]],
  [adr(0x53ecf240)]:[[adr(0x5359ef24),0xe59f1188],[adr(0x5359f0b4),adr(0x53ecf240)]],
  [adr(0x53dbf740)]:[[adr(0x5318b558),0xe59f364c],[adr(0x5318bbac),adr(0x53dbf740)]],
  [adr(0x53eceab8)]:[[adr(0x535979f8),0xe59f20cc],[adr(0x53597acc),adr(0x53eceab8)]],
};
export function checkedUiVtable(patch:Patch,native:number,expectedType=UI_NATIVE_VTABLE_TYPES[native],length=0x108):Uint8Array {
  const fail=(reason:string):never=>{throw new FirmwareError('unexpected-layout',`uiSkin invalid primary vtable 0x${native.toString(16)}: ${reason}`);};
  if(!expectedType)fail('unregistered native class');
  const constructor=CONSTRUCTOR_WORDS[native];if(!constructor)fail('no native constructor provenance');
  for(const [site,word] of constructor)if(patch.word(site)!==word)fail('native constructor reference changed');
  if(native%4)fail('unaligned address point');
  if(patch.word(native-8)!==0)fail('nonzero offset-to-top');
  const rtti=patch.word(native-4);if(rtti%4||rtti<0x53000000||rtti+8>0x53000000+patch.length)fail('invalid RTTI pointer');
  const name=patch.word(rtti+4);if(name<0x53000000||name+expectedType.length+1>0x53000000+patch.length)fail('invalid type-name pointer');
  const bytes=patch.read(name,expectedType.length+1);if(bytes[expectedType.length]!==0||Array.from(bytes.subarray(0,-1),n=>String.fromCharCode(n)).join('')!==expectedType)fail(`RTTI is not ${expectedType}`);
  // Deleting and non-deleting destructor entries must be code, not an RTTI/text word.
  for(const offset of[0,4]){const target=patch.word(native+offset);if(target%4||target<0x53100000||target>=0x53000000+0xb00000)fail('destructor slot is not native code');}
  return patch.read(native-8,length);
}
