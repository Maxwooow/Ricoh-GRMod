// SPDX-License-Identifier: GPL-2.0-only
/** Requires an independently extracted official 1.20 RTOS, rather than objects from the skin builder. */
import {existsSync,readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {Patch} from '../src/fw/gr4v120/aspect/build';
import {checkedUiVtable,UI_NATIVE_VTABLE_TYPES} from '../src/fw/gr4v120/aspect/uiskin/vtable';
const path=process.env.GRIV_UI_RTOS;
describe.skipIf(!path||!existsSync(path))('GR IV 1.20 Modern theme: native vtable provenance',()=>{
 const fresh=()=>new Patch(new Uint8Array(readFileSync(path!)));
 it('accepts every independently identified primary address point',()=>{
  const p=fresh();for(const [native,name]of Object.entries(UI_NATIVE_VTABLE_TYPES))expect(checkedUiVtable(p,+native,name)).toEqual(p.read(+native-8,0x108));
 });
 it.each([0x53ece1f8,0x53dcbb30,0x53dcbb18])('rejects the ui05 offsets or unrelated LCD class 0x%s',bad=>{
  expect(()=>checkedUiVtable(fresh(),bad)).toThrow(/invalid primary vtable/);
 });
 it('rejects a valid primary vtable when the expected controller class differs',()=>{
  expect(()=>checkedUiVtable(fresh(),0x53dcbe30,'16FnListController')).toThrow(/RTTI/);
 });
 it('rejects changed native constructor evidence before copying',()=>{
  const p=fresh();p.setWord(0x531c73b0,0x53dcbb18,'negative fixture');expect(()=>checkedUiVtable(p,0x53dcbe30)).toThrow(/constructor/);
 });
 it('rejects an invalid destructor slot',()=>{
  const p=fresh();p.setWord(0x53ece200+4,0x53ece1c4,'negative fixture');expect(()=>checkedUiVtable(p,0x53ece200)).toThrow(/destructor/);
 });
});
