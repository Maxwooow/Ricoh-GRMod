// Encode the unblurred, already resized user artwork. No pixel edits are made.
import {registerHooks} from 'node:module';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))for(const x of ['.ts','/index.ts'])try{return next(s+x,c);}catch{}throw e;}}});
const {encodeExactJpeg, checkShutdownJpeg} = await import('../../core/src/jpeg/index.ts');
const [source, output, report, ...extra] = process.argv.slice(2);
assert(source && output && report && !extra.length, 'Usage: background.rgb NEW.jpg NEW-report.json');
const rgb = await readFile(source);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(rgb), '8c8588afebb01d902221cea9768b0374e9d73833c2c501136b43876eeed9cd83');
const options = {width:720, height:480, sampling:'420', byteLength:49116, seed:1};
const result = encodeExactJpeg(rgb, options);
assert.equal(sha(result.data), 'd30f49e8fd7c8ab7b368efcf37383d1e29812246e8db5e6127c12da4908285f5');
assert.deepEqual(checkShutdownJpeg(result.data, options), {ok:true, problems:[]});
await writeFile(output, result.data, {flag:'wx'});
await writeFile(report, JSON.stringify({options, qualitySearchStartingPoint:result.quality,
  iterations:result.iterations, addedBlur:false, sourceSha256:sha(rgb), outputSha256:sha(result.data),
  quantizationTables:result.qtables.map(t => Array.from(t))}, null, 2) + '\n', {flag:'wx'});
console.log(JSON.stringify({output, bytes:result.data.length, sha256:sha(result.data)}));
