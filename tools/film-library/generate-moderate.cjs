// Pinned upstream model, wrapped from its native ProPhoto working space to sRGB.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const upstream = path.join(root, 'research/film-library-120/upstream/moderate');
// Upstream is a Photoshop plugin without a Node package boundary.
if (!fs.existsSync(upstream + '/package.json')) fs.writeFileSync(upstream + '/package.json', '{"private":true,"type":"commonjs"}\n');
const { buildLut } = require(upstream + '/core/color/film.js');
const films = require(upstream + '/core/color/films.js');
const { sample } = require(upstream + '/core/color/lut.js');
const { srgbToProPhoto, proPhotoToSrgb } = require(upstream + '/core/color/colorspace.js');
const out = path.join(root, 'research/film-library-120/sources/generated');
fs.mkdirSync(out, { recursive: true });
for (const id of ['agfa-ultra-50', 'agfa-portrait-xps-160']) {
  const film = films.byId(id), size = 65;
  const lut = buildLut(film, { size, exposure: 0, input: 'prophoto', paper: 'normalized' });
  const q = [0,0,0], v = [0,0,0], s = [0,0,0];
  const lines = [`TITLE "${film.displayName}"`, '# sRGB adapter; neutral exposure, normalized print', 'LUT_3D_SIZE 33'];
  for (let b=0;b<33;b++) for(let g=0;g<33;g++) for(let r=0;r<33;r++) {
    srgbToProPhoto(r/32,g/32,b/32,q); sample(lut,size,...q,v); proPhotoToSrgb(...v,s);
    if (!s.every(Number.isFinite)) throw new Error('Non-finite model output');
    lines.push(s.map(v=>Math.max(0,Math.min(1,v)).toFixed(8)).join(' '));
  }
  fs.writeFileSync(path.join(out,id+'.cube'),lines.join('\n')+'\n');
  fs.writeFileSync(path.join(out,id+'.json'),JSON.stringify({
    provider:'Moderate Film Simulator · sRGB 适配', url:'https://github.com/Moder4te/moderates-film-simulator',
    commit:'21058bde4245c6a3150d9fca3b60b6450150caee', license:'PolyForm Noncommercial 1.0.0',
    note:'由原模型在 ProPhoto 空间计算，转换为 sRGB；采用标准曝光和归一化印相，不包含颗粒。属于模型近似，未完成相机实拍验证。',
    model:id, nativeSize:size, input:'sRGB', output:'sRGB'
  },null,2)+'\n');
  console.log(id, lines.length-3);
}
