// SPDX-License-Identifier: GPL-2.0-only
// Pure host packing: every item's complete RGBA byte string remains intact as a subarray.
// Input prefix is immutable; offsets are byte offsets and always four-byte aligned.
export function packEqualRgbaRuns(prefix:Uint8Array,items:readonly Uint8Array[]):{bytes:Uint8Array;offsets:number[];saved:number}{
 const n=items.length,first:number[]=[],last:number[]=[],lead:number[]=[],tail:number[]=[],parents=Array.from({length:n},(_,i)=>i),next=new Array<number>(n).fill(-1),prev=new Array<number>(n).fill(-1),overlap=new Array<number>(n).fill(0);
 const rgba=(b:Uint8Array,p:number)=>(b[p]|b[p+1]<<8|b[p+2]<<16|b[p+3]<<24)>>>0;
 const find=(a:number):number=>{let r=a;while(parents[r]!==r)r=parents[r];while(parents[a]!==a){const p=parents[a];parents[a]=r;a=p;}return r;};
 const groups=new Map<number,{heads:number[];tails:number[]}>();
 const group=(k:number)=>{let g=groups.get(k);if(!g){g={heads:[],tails:[]};groups.set(k,g);}return g;};
 for(let i=0;i<n;i++){
  const b=items[i];if(!b.length||b.length%4)throw Error('non-RGBA item');first[i]=rgba(b,0);last[i]=rgba(b,b.length-4);
  let p=0;while(p<b.length&&rgba(b,p)===first[i])p+=4;lead[i]=p;
  p=b.length;while(p>0&&rgba(b,p-4)===last[i])p-=4;tail[i]=b.length-p;
  group(first[i]).heads.push(i);group(last[i]).tails.push(i);
 }
 let saved=0;
 for(const color of[...groups.keys()].sort((a,b)=>a-b)){
  const g=groups.get(color)!;g.heads.sort((a,b)=>lead[b]-lead[a]||b-a);g.tails.sort((a,b)=>tail[b]-tail[a]||b-a);
  for(const a of g.tails){for(const b of g.heads){
   if(a===b||next[a]>=0||prev[b]>=0||find(a)===find(b))continue;
   const k=Math.min(tail[a],lead[b]);next[a]=b;prev[b]=a;overlap[b]=k;parents[find(b)]=find(a);saved+=k;break;
  }}
 }
 if(prefix.length%4)throw Error('unaligned prefix');
 const length=prefix.length+items.reduce((sum,b)=>sum+b.length,0)-saved;
 const bytes=new Uint8Array(length),offsets=new Array<number>(n).fill(-1);bytes.set(prefix);let end=prefix.length,visited=0;
 for(let root=0;root<n;root++)if(prev[root]<0){for(let i=root;i>=0;i=next[i]){
  const k=overlap[i];offsets[i]=end-k;bytes.set(items[i].subarray(k),end);end+=items[i].length-k;visited++;
 }}
 if(visited!==n||end!==length)throw Error('invalid packing graph');
 // This is a structural, full-byte validation, independent of SHA/key metadata.
 for(let i=0;i<n;i++){const a=items[i],at=offsets[i];for(let j=0;j<a.length;j++)if(bytes[at+j]!==a[j])throw Error('RGBA packing byte mismatch');}
 return{bytes,offsets,saved};
}
