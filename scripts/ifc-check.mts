// 생성 IFC를 web-ifc(Node)로 파싱해 형상·속성·좌표를 확인한다: npx tsx scripts/ifc-check.mts [파일.ifc]
import { readFileSync, writeFileSync } from 'node:fs';
import * as WebIFC from 'web-ifc';
import { writeSampleIfc } from '../src/data/ifc-writer';

const file = process.argv[2];
const text = file ? readFileSync(file) : Buffer.from(writeSampleIfc(), 'utf8');
if (!file) writeFileSync('media/sample-building.ifc', text);
const api = new WebIFC.IfcAPI();
await api.Init(undefined, true);
const t0 = performance.now();
const model = api.OpenModel(new Uint8Array(text), { COORDINATE_TO_ORIGIN: false });
let meshes = 0, tris = 0;
const minY = { v: Infinity }, maxY = { v: -Infinity }, minZ = { v: Infinity }, maxZ = { v: -Infinity };
const types = new Map<string, number>();
api.StreamAllMeshes(model, (m) => {
  meshes++;
  const name = api.GetNameFromTypeCode(api.GetLineType(model, m.expressID));
  types.set(name, (types.get(name) ?? 0) + 1);
  for (let i = 0; i < m.geometries.size(); i++) {
    const pg = m.geometries.get(i);
    const g = api.GetGeometry(model, pg.geometryExpressID);
    const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
    tris += g.GetIndexDataSize() / 3;
    const M = pg.flatTransformation;
    for (let k = 0; k < v.length; k += 6) {
      const x = v[k], y = v[k + 1], z = v[k + 2];
      const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
      const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
      minY.v = Math.min(minY.v, wy); maxY.v = Math.max(maxY.v, wy);
      minZ.v = Math.min(minZ.v, wz); maxZ.v = Math.max(maxZ.v, wz);
    }
    g.delete();
  }
});
console.log('파싱+형상', (performance.now() - t0).toFixed(0), 'ms · 메시', meshes, '· 삼각형', tris);
console.log('종류', Object.fromEntries(types));
console.log('y 범위', minY.v.toFixed(2), maxY.v.toFixed(2), '· z 범위', minZ.v.toFixed(2), maxZ.v.toFixed(2));
const spaces = api.GetLineIDsWithType(model, WebIFC.IFCSPACE);
const sp = api.GetLine(model, spaces.get(0));
console.log('공간 수', spaces.size(), '· 첫 공간', sp.Name?.value, sp.LongName?.value);
const psets = await api.properties.getPropertySets(model, spaces.get(0), true);
for (const p of psets) console.log(' ', p.Name?.value, p.HasProperties.map((h: any) => `${h.Name.value}=${h.NominalValue?.value}`).join(', '));
const tree = await api.properties.getSpatialStructure(model);
console.log('구조', tree.type, '>', tree.children[0]?.type, '>', tree.children[0]?.children[0]?.type, '>', tree.children[0]?.children[0]?.children.length, '층');
api.CloseModel(model);
