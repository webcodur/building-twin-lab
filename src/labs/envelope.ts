import * as THREE from 'three';
import { createStage } from '../core/stage';
import { Panel, createTooltip } from '../core/panel';
import { RAMPS, sampleRamp, type Ramp } from '../core/colormap';
import { layout, type Lab } from './types';

/**
 * 외피 분석: 태양 궤적·차폐를 반영한 입면 일사, U값 기반 열손실, 리노베이션 전후 비교.
 * 값은 단순화한 공학 근사다. 목적은 "어느 면이 문제인가"를 3D로 즉시 보이는 것이다.
 */

const CITIES = {
  seoul: { name: '서울', lat: 37.57, hdd: 2900 },
  paris: { name: '파리', lat: 48.86, hdd: 2500 },
  barcelona: { name: '바르셀로나', lat: 41.39, hdd: 1300 },
} as const;
type City = keyof typeof CITIES;

const B = { w: 30, d: 18, floors: 8, fh: 3.5, col: 3 };
const RETROFIT = {
  before: { wall: 1.2, win: 2.8, roof: 0.8, label: '현재(1990년대 수준)' },
  after: { wall: 0.24, win: 1.1, roof: 0.15, label: '리노베이션 후' },
};

type Mode = 'instant' | 'daily' | 'heatloss';

interface Cell {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  area: number;
  roof: boolean;
  face: 'N' | 'S' | 'E' | 'W' | 'R';
  /** 열교 배수: 모서리·최상층·최하층은 선형 열교로 손실이 커진다. */
  bridge: number;
}

/** 위도·연중 일자·태양시로 태양 방향 단위벡터(x 동, y 위, z 남)를 구한다. */
export function sunDirection(lat: number, day: number, hour: number, out = new THREE.Vector3()) {
  const r = Math.PI / 180;
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (284 + day)) * r;
  const H = 15 * (hour - 12) * r;
  const phi = lat * r;
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const alt = Math.asin(sinAlt);
  // 남쪽 기준 방위각(서쪽 +)
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi));
  return { dir: out.set(-Math.cos(alt) * Math.sin(az), Math.sin(alt), Math.cos(alt) * Math.cos(az)), alt };
}

export const envelopeLab: Lab = {
  id: 'envelope',
  title: '외피 일사·열손실·리노베이션',
  tag: '진단·ESG',
  summary: '태양 궤적과 주변 건물 그림자를 반영해 입면별 일사를 구하고, U값으로 열손실을 열화상처럼 본다. 리노베이션 전후 연간 난방 부하를 비교한다.',
  mount(el) {
    const { viewport, side } = layout(el);
    const stage = createStage(viewport, { shadows: true, background: 0x0c1324 });
    const { scene, camera, controls } = stage;
    camera.position.set(-62, 92, 118);
    controls.target.set(0, 8, 0);

    scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x202a3d, 0.5));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 300 });
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 1 }));
    ground.receiveShadow = true;
    scene.add(ground);

    // 대상 건물 몸체
    const H = B.floors * B.fh;
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(B.w - 0.2, H - 0.1, B.d - 0.2), bodyMat);
    body.position.y = H / 2;
    body.castShadow = body.receiveShadow = true;
    scene.add(body);

    // 주변 건물(차폐물). 시드 고정 난수로 매번 같은 배치를 만든다.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const neighbors: THREE.Mesh[] = [];
    const nMat = new THREE.MeshStandardMaterial({ color: 0x5b6474, roughness: 0.9 });
    const spots: Array<[number, number]> = [[-45, -5], [-42, 30], [0, 38], [40, 32], [48, -4], [38, -38], [0, -42], [-38, -36], [-70, 10], [70, 12]];
    for (const [x, z] of spots) {
      const w = 14 + rnd() * 14, d = 12 + rnd() * 12, h = 8 + rnd() * 36;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), nMat);
      m.position.set(x, h / 2, z);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
      neighbors.push(m);
    }

    // 입면·지붕을 3m × 층고 셀로 나눈다.
    const cells: Cell[] = [];
    const faces: Array<{ face: Cell['face']; n: THREE.Vector3; len: number; at: (u: number, y: number) => THREE.Vector3 }> = [
      { face: 'S', n: new THREE.Vector3(0, 0, 1), len: B.w, at: (u, y) => new THREE.Vector3(-B.w / 2 + u, y, B.d / 2) },
      { face: 'N', n: new THREE.Vector3(0, 0, -1), len: B.w, at: (u, y) => new THREE.Vector3(B.w / 2 - u, y, -B.d / 2) },
      { face: 'E', n: new THREE.Vector3(1, 0, 0), len: B.d, at: (u, y) => new THREE.Vector3(B.w / 2, y, B.d / 2 - u) },
      { face: 'W', n: new THREE.Vector3(-1, 0, 0), len: B.d, at: (u, y) => new THREE.Vector3(-B.w / 2, y, -B.d / 2 + u) },
    ];
    for (const f of faces)
      for (let c = 0; c < f.len / B.col; c++)
        for (let fl = 0; fl < B.floors; fl++)
          cells.push({
            center: f.at((c + 0.5) * B.col, (fl + 0.5) * B.fh),
            normal: f.n,
            area: B.col * B.fh,
            roof: false,
            face: f.face,
            bridge: (c === 0 || c === f.len / B.col - 1 ? 1.3 : 1) * (fl === 0 || fl === B.floors - 1 ? 1.12 : 1),
          });
    for (let i = 0; i < B.w / B.col; i++)
      for (let j = 0; j < B.d / B.col; j++)
        cells.push({ center: new THREE.Vector3(-B.w / 2 + (i + 0.5) * B.col, H, -B.d / 2 + (j + 0.5) * B.col), normal: new THREE.Vector3(0, 1, 0), area: B.col * B.col, roof: true, face: 'R', bridge: i === 0 || j === 0 || i === B.w / B.col - 1 || j === B.d / B.col - 1 ? 1.2 : 1 });

    const quad = new THREE.PlaneGeometry(B.col * 0.94, B.fh * 0.9);
    const cellMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 });
    const thermalMat = new THREE.MeshBasicMaterial();
    const inst = new THREE.InstancedMesh<THREE.PlaneGeometry, THREE.Material>(quad, cellMat, cells.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    cells.forEach((c, i) => {
      q.setFromUnitVectors(zAxis, c.normal);
      const p = c.center.clone().addScaledVector(c.normal, 0.06);
      const s = c.roof ? new THREE.Vector3(1, B.col / B.fh, 1) : new THREE.Vector3(1, 1, 1);
      inst.setMatrixAt(i, m4.compose(p, q, s));
      inst.setColorAt(i, new THREE.Color(0xffffff));
    });
    scene.add(inst);

    // 태양 궤적 표시(반지름 90 하늘 돔 위)
    const R = 90;
    const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xfacc15, dashSize: 2, gapSize: 1.5, transparent: true, opacity: 0.7 }));
    scene.add(pathLine);
    const sunBall = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
    scene.add(sunBall);

    const state = { city: 'seoul' as City, day: 172, hour: 14, mode: 'daily' as Mode, wwr: 0.45, u: { ...RETROFIT.before }, scenario: 'before' as 'before' | 'after' };
    const values = new Float32Array(cells.length);
    const ray = new THREE.Raycaster();
    const tmpDir = new THREE.Vector3();

    function irradiance(c: Cell, dir: THREE.Vector3, alt: number): number {
      if (alt <= 0) return 0;
      const dni = 900 * Math.pow(Math.sin(alt), 0.35);
      const cos = c.normal.dot(dir);
      let direct = 0;
      if (cos > 0) {
        ray.set(c.center.clone().addScaledVector(c.normal, 0.3), dir);
        ray.far = 400;
        direct = ray.intersectObjects(neighbors, false).length ? 0 : dni * cos;
      }
      const diffuse = 110 * Math.sin(alt) * (c.roof ? 1 : 0.5);
      return direct + diffuse;
    }

    function compute() {
      const city = CITIES[state.city];
      const { dir, alt } = sunDirection(city.lat, state.day, state.hour, tmpDir);
      // 조명·태양 구
      sun.position.copy(dir).multiplyScalar(120);
      sun.intensity = alt > 0 ? 2.4 * Math.min(1, Math.sin(alt) * 3) : 0;
      sunBall.position.copy(dir).multiplyScalar(R);
      sunBall.visible = alt > 0;
      const pts: THREE.Vector3[] = [];
      for (let h = 4; h <= 20; h += 0.25) {
        const s = sunDirection(city.lat, state.day, h);
        if (s.alt > 0) pts.push(s.dir.clone().multiplyScalar(R));
      }
      pathLine.geometry.dispose();
      pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      pathLine.computeLineDistances();

      const totals: Record<Cell['face'], number> = { N: 0, S: 0, E: 0, W: 0, R: 0 };
      let ramp: Ramp = RAMPS.thermal;
      let max = 1;
      if (state.mode === 'instant') {
        cells.forEach((c, i) => (values[i] = irradiance(c, dir, alt)));
        max = 900;
        cells.forEach((c, i) => (totals[c.face] += (values[i] * c.area) / 1000));
      } else if (state.mode === 'daily') {
        values.fill(0);
        const d = new THREE.Vector3();
        for (let h = 4; h <= 20; h += 0.5) {
          const s = sunDirection(city.lat, state.day, h, d);
          if (s.alt <= 0) continue;
          cells.forEach((c, i) => (values[i] += (irradiance(c, s.dir, s.alt) * 0.5) / 1000)); // kWh/㎡
        }
        max = 7;
        cells.forEach((c, i) => (totals[c.face] += values[i] * c.area));
      } else {
        const dT = 20 - -5;
        cells.forEach((c, i) => {
          const u = c.roof ? state.u.roof : state.wwr * state.u.win + (1 - state.wwr) * state.u.wall;
          values[i] = u * c.bridge * dT; // W/㎡
          totals[c.face] += (values[i] * c.area) / 1000;
        });
        max = 70;
        ramp = RAMPS.inferno;
      }
      const col = new THREE.Color();
      cells.forEach((_, i) => inst.setColorAt(i, sampleRamp(ramp, values[i] / max, col)));
      inst.instanceColor!.needsUpdate = true;
      // 인스턴스 색은 diffuse에만 곱해진다(emissive에는 안 곱해진다).
      // 열화상 모드는 조명 영향을 없애려고 무광원 재질로 바꿔 끼운다.
      inst.material = state.mode === 'heatloss' ? thermalMat : cellMat;
      renderStats(totals, dir, alt);
    }

    // ── 패널 ──────────────────────────────────────────────────────
    const panel = new Panel(side, '외피 일사·열손실·리노베이션', '입면을 3m × 층고 셀로 나눠 셀마다 값을 칠했다. 셀에 마우스를 올리면 값이 보인다.');
    panel.section('보기');
    panel.segmented('지표', { instant: '순간 일사', daily: '하루 일사', heatloss: '열손실' } as Record<Mode, string>, state.mode, (v) => {
      state.mode = v;
      renderLegend();
      compute();
    });
    const legendBox = panel.info();
    panel.section('장소·시각');
    panel.select('도시', Object.fromEntries(Object.entries(CITIES).map(([k, v]) => [k, v.name])) as Record<City, string>, state.city, (v) => {
      state.city = v;
      compute();
    });
    panel.slider('날짜', { min: 1, max: 365, step: 1, value: state.day, format: dayLabel }, (v) => {
      state.day = v;
      compute();
    });
    panel.slider('태양시', { min: 4, max: 20, step: 0.25, value: state.hour, format: (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}` }, (v) => {
      state.hour = v;
      compute();
    });
    panel.section('외피 성능');
    panel.segmented('상태', { before: '현재', after: '리노베이션 후' }, state.scenario, (v) => {
      state.scenario = v;
      state.u = { ...RETROFIT[v] };
      uInputs.forEach(([k, input]) => {
        input.value = String(state.u[k]);
        input.dispatchEvent(new Event('sync'));
      });
      compute();
    });
    const uInputs: Array<['wall' | 'win' | 'roof', HTMLInputElement]> = [
      ['wall', panel.slider('벽 U값', { min: 0.1, max: 2, step: 0.01, value: state.u.wall, format: (v) => `${v.toFixed(2)}` }, (v) => ((state.u.wall = v), compute()))],
      ['win', panel.slider('창 U값', { min: 0.6, max: 5.8, step: 0.1, value: state.u.win, format: (v) => `${v.toFixed(1)}` }, (v) => ((state.u.win = v), compute()))],
      ['roof', panel.slider('지붕 U값', { min: 0.1, max: 1.5, step: 0.01, value: state.u.roof, format: (v) => `${v.toFixed(2)}` }, (v) => ((state.u.roof = v), compute()))],
    ];
    panel.slider('창면적비', { min: 0.1, max: 0.9, step: 0.05, value: state.wwr, format: (v) => `${Math.round(v * 100)}%` }, (v) => {
      state.wwr = v;
      compute();
    });
    panel.section('산출');
    const stats = panel.info();

    function renderLegend() {
      const [r, a, b] =
        state.mode === 'instant' ? [RAMPS.thermal, '0', '900 W/㎡'] : state.mode === 'daily' ? [RAMPS.thermal, '0', '7 kWh/㎡·일'] : [RAMPS.inferno, '0', '70 W/㎡ (ΔT 25℃)'];
      legendBox.innerHTML = '';
      legendBox.appendChild(panel.legend(r, a, b));
    }

    function annualHeat(u: { wall: number; win: number; roof: number }) {
      const wallA = 2 * (B.w + B.d) * H;
      const roofA = B.w * B.d;
      const UA = wallA * (state.wwr * u.win + (1 - state.wwr) * u.wall) + roofA * u.roof;
      return { UA, kwh: (UA * CITIES[state.city].hdd * 24) / 1000 };
    }

    function renderStats(t: Record<Cell['face'], number>, _dir: THREE.Vector3, alt: number) {
      const unit = state.mode === 'instant' ? 'kW' : state.mode === 'daily' ? 'kWh/일' : 'kW';
      const pre = annualHeat(RETROFIT.before);
      const now = annualHeat(state.u);
      const gfa = B.w * B.d * B.floors;
      stats.innerHTML = `
        <div class="kv"><span>태양 고도</span><span>${((alt * 180) / Math.PI).toFixed(1)}°</span></div>
        ${(['S', 'E', 'W', 'N', 'R'] as const).map((f) => `<div class="kv"><span>${{ S: '남', E: '동', W: '서', N: '북', R: '지붕' }[f]}면 합계</span><span>${t[f].toFixed(0)} ${unit}</span></div>`).join('')}
        ${state.mode === 'daily' ? `<div class="kv"><span>지붕 태양광 잠재량</span><span><em>${(t.R * 0.2 * 0.75).toFixed(0)} kWh/일</em></span></div>` : ''}
        <div class="kv"><span>외피 열관류(UA)</span><span>${now.UA.toFixed(0)} W/K</span></div>
        <div class="kv"><span>연간 난방 부하</span><span>${(now.kwh / 1000).toFixed(0)} MWh · ${(now.kwh / gfa).toFixed(0)} kWh/㎡</span></div>
        <div class="kv big"><span>현재 대비 절감</span><span><em>${((1 - now.kwh / pre.kwh) * 100).toFixed(0)}%</em></span></div>
        <p class="muted" style="margin-top:10px">난방 부하 = UA × 난방도일(${CITIES[state.city].name} ${CITIES[state.city].hdd}) × 24. 환기·일사 취득은 뺀 근사다. 열화상 색에는 모서리·슬래브 단부 열교를 반영했다.</p>`;
    }

    // ── 셀 툴팁 ───────────────────────────────────────────────────
    const tip = createTooltip(viewport);
    stage.labels.domElement.addEventListener('pointermove', (e) => {
      ray.setFromCamera(stage.toNdc(e), camera);
      ray.far = Infinity;
      const hit = ray.intersectObject(inst)[0];
      if (hit?.instanceId === undefined) return tip.hide();
      const c = cells[hit.instanceId];
      const v = values[hit.instanceId];
      const unit = state.mode === 'instant' ? 'W/㎡' : state.mode === 'daily' ? 'kWh/㎡·일' : 'W/㎡';
      const r = viewport.getBoundingClientRect();
      tip.show(`<b>${{ S: '남', E: '동', W: '서', N: '북', R: '지붕' }[c.face]}면 ${c.roof ? '' : `${Math.floor(c.center.y / B.fh) + 1}층`}</b><br>${v.toFixed(state.mode === 'daily' ? 2 : 0)} ${unit}`, e.clientX - r.left, e.clientY - r.top);
    });

    renderLegend();
    compute();
    return () => {
      thermalMat.dispose();
      cellMat.dispose();
      stage.dispose();
    };
  },
};

function dayLabel(d: number): string {
  const date = new Date(2026, 0, d);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
