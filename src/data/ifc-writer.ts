import { createBuilding, FLOOR_HEIGHT, FLOORS, FOOTPRINT, type Zone } from './building';

/**
 * 가상 건물을 IFC4 파일(STEP 텍스트)로 쓴다.
 * 외부 샘플 없이 표준 파일을 만들기 위한 최소 작성기다. 다른 BIM 뷰어에서도 열린다.
 *
 * IFC 좌표: X 동, Y 북, Z 위. 앱 좌표(x 동, z 남, y 위)와는 Y = -z 관계다.
 * 공간(IfcSpace)마다 BMS 연결 속성(Pset_BmsLink)을 붙여 3D 공간과 제어 존을 잇는다.
 */

const WALL_U = 1.2;
const WINDOW_U = 2.8;

export function writeSampleIfc(): string {
  const zones = createBuilding();
  const lines: string[] = [];
  let id = 0;
  const add = (body: string) => {
    lines.push(`#${++id}=${body};`);
    return `#${id}`;
  };

  // 결정적 GlobalId(22자, IFC 압축 문자 집합)
  const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  let seed = 7;
  const guid = () => {
    let g = CH[(seed = (seed * 48271) % 2147483647) % 4];
    for (let i = 0; i < 21; i++) g += CH[(seed = (seed * 48271) % 2147483647) % 64];
    return `'${g}'`;
  };

  // ── 공통: 원점·방향·컨텍스트·단위 ───────────────────────────────
  const origin = add('IFCCARTESIANPOINT((0.,0.,0.))');
  const zDir = add('IFCDIRECTION((0.,0.,1.))');
  const xDir = add('IFCDIRECTION((1.,0.,0.))');
  const worldAxis = add(`IFCAXIS2PLACEMENT3D(${origin},${zDir},${xDir})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${worldAxis},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = add(
    `IFCUNITASSIGNMENT((${add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')},${add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)')},${add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)')}))`,
  );
  const project = add(`IFCPROJECT(${guid()},$,${str('Building Twin Lab')},${str('가상 업무시설 PoC 모델')},$,$,$,(${ctx}),${units})`);

  const placement = (rel: string | null, x: number, y: number, z: number) =>
    add(`IFCLOCALPLACEMENT(${rel ?? '$'},${add(`IFCAXIS2PLACEMENT3D(${add(`IFCCARTESIANPOINT((${n(x)},${n(y)},${n(z)}))`)},$,$)`)})`);

  // 표면 색(재질 대신 쓰는 최소 표현)
  const style = (r: number, g: number, b: number, transparency: number) =>
    add(
      `IFCSURFACESTYLE($,.BOTH.,(${add(`IFCSURFACESTYLERENDERING(${add(`IFCCOLOURRGB($,${n(r)},${n(g)},${n(b)})`)},${n(transparency)},$,$,$,$,$,$,.NOTDEFINED.)`)}))`,
    );
  const STYLE = {
    slab: style(0.62, 0.65, 0.7, 0),
    wall: style(0.88, 0.87, 0.84, 0),
    glass: style(0.45, 0.72, 0.9, 0.55),
    space: style(0.35, 0.6, 1, 0.7),
  };

  /** 직육면체 형상: 중심(cx, cy), 바닥 높이 z0에서 높이 h만큼 밀어 올린다. */
  const box = (w: number, d: number, h: number, st: string) => {
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${add(`IFCAXIS2PLACEMENT2D(${add('IFCCARTESIANPOINT((0.,0.))')},$)`)},${n(w)},${n(d)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(${profile},${worldAxis},${zDir},${n(h)})`);
    add(`IFCSTYLEDITEM(${solid},(${st}),$)`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`)}))`);
  };

  const pset = (name: string, props: Array<[string, string]>, objects: string[]) => {
    const ps = props.map(([k, v]) => add(`IFCPROPERTYSINGLEVALUE(${str(k)},$,${v},$)`));
    const set = add(`IFCPROPERTYSET(${guid()},$,${str(name)},$,(${ps.join(',')}))`);
    add(`IFCRELDEFINESBYPROPERTIES(${guid()},$,$,$,(${objects.join(',')}),${set})`);
  };

  // ── 공간 구조: 대지 > 건물 > 층 ───────────────────────────────
  const sitePl = placement(null, 0, 0, 0);
  const site = add(`IFCSITE(${guid()},$,${str('대지')},$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldgPl = placement(sitePl, 0, 0, 0);
  const building = add(`IFCBUILDING(${guid()},$,${str('가상 업무시설')},$,$,${bldgPl},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${project},(${site}))`);
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${site},(${building}))`);

  const extWalls: string[] = [];
  const windows: string[] = [];
  const storeys: string[] = [];
  const W = FOOTPRINT.w;
  const D = FOOTPRINT.d;

  for (let f = 0; f < FLOORS; f++) {
    const elev = f * FLOOR_HEIGHT;
    const stPl = placement(bldgPl, 0, 0, elev);
    const storey = add(`IFCBUILDINGSTOREY(${guid()},$,${str(`${f + 1}F`)},$,$,${stPl},$,${str(`${f + 1}층`)},.ELEMENT.,${n(elev)})`);
    storeys.push(storey);
    const contained: string[] = [];

    const slab = add(`IFCSLAB(${guid()},$,${str(`${f + 1}F 바닥 슬래브`)},$,$,${placement(stPl, 0, 0, 0)},${box(W + 0.6, D + 0.6, 0.3, STYLE.slab)},$,.FLOOR.)`);
    contained.push(slab);

    // 외벽 4면 (남 Y-, 북 Y+, 동 X+, 서 X-)
    const wh = FLOOR_HEIGHT - 0.3;
    const walls: Array<[string, number, number, number, number, number, number]> = [
      ['남측 외벽', 0, -D / 2, W + 0.3, 0.3, 0, -1],
      ['북측 외벽', 0, D / 2, W + 0.3, 0.3, 0, 1],
      ['동측 외벽', W / 2, 0, 0.3, D, 1, 0],
      ['서측 외벽', -W / 2, 0, 0.3, D, -1, 0],
    ];
    for (const [name, cx, cy, w, d, nx, ny] of walls) {
      const wall = add(`IFCWALL(${guid()},$,${str(`${f + 1}F ${name}`)},$,$,${placement(stPl, cx, cy, 0.3)},${box(w, d, wh, STYLE.wall)},$,.SOLIDWALL.)`);
      contained.push(wall);
      extWalls.push(wall);
      // 창: 벽 바깥면에 3m 폭 유리를 4m 간격으로 붙인다(개구부 생략).
      const len = nx === 0 ? W : D;
      for (let s = -len / 2 + 2.5; s <= len / 2 - 2.5; s += 4) {
        const wx = nx === 0 ? s : cx + nx * 0.18;
        const wy = nx === 0 ? cy + ny * 0.18 : s;
        const win = add(
          `IFCWINDOW(${guid()},$,${str(`${f + 1}F ${name} 창`)},$,$,${placement(stPl, wx, wy, 1.2)},${box(nx === 0 ? 3 : 0.06, nx === 0 ? 0.06 : 3, 1.6, STYLE.glass)},$,1.6,3.,.WINDOW.,$,$)`,
        );
        contained.push(win);
        windows.push(win);
      }
    }
    if (f === FLOORS - 1) {
      contained.push(add(`IFCSLAB(${guid()},$,${str('지붕 슬래브')},$,$,${placement(stPl, 0, 0, FLOOR_HEIGHT)},${box(W + 0.6, D + 0.6, 0.3, STYLE.slab)},$,.ROOF.)`));
    }
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},$,$,$,(${contained.join(',')}),${storey})`);

    // 공간(존): 층에 집합(aggregate)된다.
    const spaces = zones.filter((z) => z.floor === f).map((z) => writeSpace(z, stPl));
    add(`IFCRELAGGREGATES(${guid()},$,$,$,${storey},(${spaces.join(',')}))`);
  }
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${building},(${storeys.join(',')}))`);

  pset('Pset_WallCommon', [['IsExternal', 'IFCBOOLEAN(.T.)'], ['LoadBearing', 'IFCBOOLEAN(.F.)'], ['ThermalTransmittance', `IFCTHERMALTRANSMITTANCEMEASURE(${n(WALL_U)})`]], extWalls);
  pset('Pset_WindowCommon', [['IsExternal', 'IFCBOOLEAN(.T.)'], ['ThermalTransmittance', `IFCTHERMALTRANSMITTANCEMEASURE(${n(WINDOW_U)})`]], windows);

  function writeSpace(z: Zone, stPl: string): string {
    const { x0, x1, z0, z1 } = z.rect;
    const cx = (x0 + x1) / 2;
    const cy = -(z0 + z1) / 2;
    const sp = add(
      `IFCSPACE(${guid()},$,${str(z.id)},$,$,${placement(stPl, cx, cy, 0.3)},${box(x1 - x0 - 0.3, z1 - z0 - 0.3, FLOOR_HEIGHT - 0.6, STYLE.space)},${str(z.name)},.ELEMENT.,.SPACE.,$)`,
    );
    pset('Pset_SpaceCommon', [['Reference', `IFCIDENTIFIER(${str(z.id)})`], ['IsExternal', `IFCBOOLEAN(${z.orient === 'C' ? '.F.' : '.T.'})`], ['GrossPlannedArea', `IFCAREAMEASURE(${n(z.area)})`]], [sp]);
    pset(
      'Pset_BmsLink',
      [
        ['ZoneId', `IFCLABEL(${str(z.id)})`],
        ['AirHandlingUnit', `IFCLABEL(${str(z.floor < 3 ? 'AHU-1' : 'AHU-2')})`],
        ['ZoneTempPoint', `IFCLABEL(${str(`${z.floor < 3 ? 'AHU-1' : 'AHU-2'}.VAV-${z.id}.ZoneTemp`)})`],
        ['SetpointPoint', `IFCLABEL(${str(`${z.floor < 3 ? 'AHU-1' : 'AHU-2'}.VAV-${z.id}.Setpoint`)})`],
      ],
      [sp],
    );
    return sp;
  }

  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('building-twin-lab.ifc','2026-11-23T00:00:00',(''),(''),'building-twin-lab','building-twin-lab','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** STEP 실수: 소수점이 반드시 있어야 한다. */
function n(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  return Number.isInteger(r) ? `${r}.` : String(r);
}

/** STEP 문자열: 작은따옴표는 두 번, ASCII 밖 문자는 \X2\ 블록(UTF-16 16진수)으로 쓴다. */
function str(s: string): string {
  let out = '';
  let wide = '';
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = '';
  };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c > 0x7e) wide += c.toString(16).toUpperCase().padStart(4, '0');
    else {
      flush();
      out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch;
    }
  }
  flush();
  return `'${out}'`;
}
