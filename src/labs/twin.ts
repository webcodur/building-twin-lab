import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createStage } from '../core/stage';
import { Panel, createTooltip } from '../core/panel';
import { RAMPS, sampleRamp } from '../core/colormap';
import { drawChart } from '../core/chart';
import { createBuilding, FLOOR_HEIGHT, FLOORS, FOOTPRINT, type Zone } from '../data/building';
import { simulate, STEPS, COMFORT, fmtTime, type Scenario } from '../sim/thermal';
import { layout, type Lab } from './types';

type Mode = 'temp' | 'occ' | 'power' | 'comfort';

const MODE_RAMP = { temp: RAMPS.thermal, occ: RAMPS.occupancy, power: RAMPS.thermal, comfort: RAMPS.status } as const;
const MODE_LEGEND: Record<Mode, [string, string]> = {
  temp: ['22℃', '30℃'],
  occ: ['비어 있음', '만석'],
  power: ['0 W/m²', '40 W/m²'],
  comfort: ['쾌적', '범위 밖 3℃'],
};

export const twinLab: Lab = {
  id: 'twin',
  title: '디지털 트윈 운영 화면',
  tag: '운영·제어',
  summary: '존별 온도·재실·전력·쾌적도를 3D 건물 위에 겹쳐 보고, 고정 스케줄과 AI 제어의 하루를 시간대별로 비교한다.',
  mount(el) {
    const { viewport, side } = layout(el);
    const stage = createStage(viewport, { shadows: true, background: 0x0a0f1e });
    const { scene, camera, controls, renderer } = stage;
    camera.position.set(52, 38, 58);
    controls.target.set(0, 8, 0);

    const zones = createBuilding();
    const sim = simulate(zones);

    // ── 조명·바닥 ─────────────────────────────────────────────
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1f2e, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(40, 60, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 200 });
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(120, 64), new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(240, 80, 0x22304d, 0x16203a);
    grid.position.y = 0.01;
    scene.add(grid);

    // ── 건물: 층 그룹 > 슬래브 + 존 볼륨 + 외곽선 ─────────────────
    const floors: THREE.Group[] = [];
    const zoneMeshes: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x8a93a6, roughness: 0.8 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.35 });

    for (let f = 0; f < FLOORS; f++) {
      const g = new THREE.Group();
      g.userData.baseY = f * FLOOR_HEIGHT;
      g.position.y = g.userData.baseY;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(FOOTPRINT.w + 0.6, 0.3, FOOTPRINT.d + 0.6), slabMat);
      slab.position.y = 0.15;
      slab.castShadow = slab.receiveShadow = true;
      g.add(slab);
      const shell = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(FOOTPRINT.w, FLOOR_HEIGHT - 0.3, FOOTPRINT.d)),
        edgeMat,
      );
      shell.position.y = 0.3 + (FLOOR_HEIGHT - 0.3) / 2;
      g.add(shell);

      const tag = document.createElement('div');
      tag.className = 'floor-tag';
      tag.textContent = `${f + 1}F`;
      const tagObj = new CSS2DObject(tag);
      tagObj.position.set(-FOOTPRINT.w / 2 - 3, FLOOR_HEIGHT / 2, FOOTPRINT.d / 2);
      g.add(tagObj);

      scene.add(g);
      floors.push(g);
    }

    zones.forEach((z, i) => {
      const { x0, x1, z0, z1 } = z.rect;
      const h = FLOOR_HEIGHT - 0.9;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(x1 - x0 - 0.7, h, z1 - z0 - 0.7),
        new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.9, roughness: 0.45, metalness: 0.05 }),
      );
      m.position.set((x0 + x1) / 2, 0.3 + h / 2 + 0.05, (z0 + z1) / 2);
      m.userData.index = i;
      m.castShadow = true;
      floors[z.floor].add(m);
      zoneMeshes.push(m);
    });

    // ── 옥상 설비: 공조기 2대 + 회전 팬 ───────────────────────────
    const roof = new THREE.Group();
    const fans: THREE.Mesh[] = [];
    const unitMat = new THREE.MeshStandardMaterial({ color: 0xc9d1e0, metalness: 0.6, roughness: 0.35 });
    const fanMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.4, roughness: 0.5 });
    [-2, 6].forEach((x) => {
      const box = new THREE.Mesh(new THREE.BoxGeometry(6, 2.2, 4), unitMat);
      box.position.set(x, 1.1, -2);
      box.castShadow = true;
      roof.add(box);
      for (const dx of [-1.5, 1.5]) {
        const fan = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.15, 6), fanMat);
        fan.position.set(x + dx, 2.3, -2);
        roof.add(fan);
        fans.push(fan);
      }
    });
    roof.userData.baseY = FLOORS * FLOOR_HEIGHT;
    roof.position.y = roof.userData.baseY;
    scene.add(roof);

    // ── 급기 흐름 입자: 옥상 → 코어 샤프트 → 각 존 천장 ──────────
    const SHAFT = new THREE.Vector2(8, 0);
    const PER_ZONE = 14;
    const pathOf = (z: Zone, explode: number) => {
      const fy = z.floor * FLOOR_HEIGHT * (1 + explode) + FLOOR_HEIGHT - 0.45;
      const topY = FLOORS * FLOOR_HEIGHT * (1 + explode) + 1.2;
      const cx = (z.rect.x0 + z.rect.x1) / 2;
      const cz = (z.rect.z0 + z.rect.z1) / 2;
      return [new THREE.Vector3(SHAFT.x, topY, SHAFT.y), new THREE.Vector3(SHAFT.x, fy, SHAFT.y), new THREE.Vector3(cx, fy, cz)];
    };
    const flowCount = zones.length * PER_ZONE;
    const flowPos = new Float32Array(flowCount * 3);
    const flowU = new Float32Array(flowCount).map(() => Math.random());
    const flowGeo = new THREE.BufferGeometry();
    flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3));
    const flow = new THREE.Points(
      flowGeo,
      new THREE.PointsMaterial({ size: 0.55, color: 0x7dd3fc, map: dotTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    flow.frustumCulled = false;
    scene.add(flow);

    // ── 센서 결측 표지 ────────────────────────────────────────────
    const gapMarks = zones.flatMap((z, i) => {
      if (!z.dataGap) return [];
      const d = document.createElement('div');
      d.className = 'alert-tag';
      d.innerHTML = '<i></i>센서 결측 · 보간 중';
      const o = new CSS2DObject(d);
      o.position.copy(zoneMeshes[i].position).add(new THREE.Vector3(0, 1.6, 0));
      floors[z.floor].add(o);
      return [{ z, o }];
    });

    // ── 후처리: 선택 존 외곽선 ────────────────────────────────────
    const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
    composer.addPass(new RenderPass(scene, camera));
    const outline = new OutlinePass(new THREE.Vector2(1, 1), scene, camera);
    Object.assign(outline, { edgeStrength: 4, edgeGlow: 0.6, edgeThickness: 1.5 });
    outline.visibleEdgeColor.set(0xffffff);
    outline.hiddenEdgeColor.set(0x5b6b9a);
    composer.addPass(outline);
    composer.addPass(new OutputPass());
    stage.onResize((w, h) => {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    });
    stage.setRender(() => composer.render());

    // ── 상태 ──────────────────────────────────────────────────────
    const state = { step: 9 * 12, mode: 'temp' as Mode, scenario: 'ai' as Scenario, explode: 0, floor: -1, playing: true, speed: 1.0 };
    let hovered = -1;
    let selected = -1;
    let stepF = state.step;

    // ── 패널 ──────────────────────────────────────────────────────
    const panel = new Panel(side, '디지털 트윈 운영 화면', '여름 평일 하루를 5분 간격으로 시뮬레이션했다. 존을 누르면 상세가 열린다.');
    panel.section('보기');
    panel.segmented('지표', { temp: '온도', occ: '재실', power: '전력', comfort: '쾌적' } as Record<Mode, string>, state.mode, (v) => {
      state.mode = v;
      // 새 범례는 패널 끝에 붙으므로 옛 범례 자리로 옮긴다.
      legend.replaceWith((legend = panel.legend(MODE_RAMP[v], ...MODE_LEGEND[v])));
    });
    let legend = panel.legend(MODE_RAMP.temp, ...MODE_LEGEND.temp);
    panel.segmented('제어', { baseline: '고정 스케줄', ai: 'AI 제어' } as Record<Scenario, string>, state.scenario, (v) => (state.scenario = v));
    panel.select('층', { '-1': '전체', ...Object.fromEntries(floors.map((_, i) => [String(i), `${i + 1}층만`])) }, '-1', (v) => (state.floor = Number(v)));
    panel.slider('층 분리', { min: 0, max: 1.5, step: 0.01, value: 0, format: (v) => `${Math.round(v * 100)}%` }, (v) => (state.explode = v));
    panel.section('하루 지표');
    const kpi = panel.info('kpi');
    panel.section('선택한 존');
    const detail = panel.info('detail');
    detail.innerHTML = '<p class="muted">건물 안의 존을 눌러 고른다.</p>';
    const spark = document.createElement('canvas');
    spark.className = 'spark';

    // 하단 시간 막대
    const bar = document.createElement('div');
    bar.className = 'timebar';
    bar.innerHTML = `<button class="play" title="재생/정지">❚❚</button><span class="clock"></span>
      <input type="range" min="0" max="${STEPS - 1}" step="1" />
      <div class="chart-wrap"><canvas></canvas><div class="chart-legend"><span class="b">고정 스케줄 kW</span><span class="a">AI 제어 kW</span><span class="o">외기온도</span></div></div>`;
    viewport.appendChild(bar);
    const playBtn = bar.querySelector<HTMLButtonElement>('.play')!;
    const clockEl = bar.querySelector<HTMLElement>('.clock')!;
    const range = bar.querySelector<HTMLInputElement>('input')!;
    const chart = bar.querySelector<HTMLCanvasElement>('canvas')!;
    playBtn.onclick = () => {
      state.playing = !state.playing;
      playBtn.textContent = state.playing ? '❚❚' : '▶';
    };
    range.oninput = () => {
      stepF = state.step = Number(range.value);
    };
    const maxKw = Math.max(...sim.baseline.totalPower) * 1.1;
    const outdoorScaled = Array.from(sim.outdoor, (t) => ((t - 20) / 16) * maxKw);

    // ── 상호작용 ──────────────────────────────────────────────────
    const tooltip = createTooltip(viewport);
    const ray = new THREE.Raycaster();
    const pick = (e: PointerEvent) => {
      ray.setFromCamera(stage.toNdc(e), camera);
      const hit = ray.intersectObjects(zoneMeshes.filter((m) => m.visible && (state.floor < 0 || zones[m.userData.index].floor === state.floor)))[0];
      return hit ? (hit.object.userData.index as number) : -1;
    };
    const dom = stage.labels.domElement;
    let downAt = 0;
    dom.addEventListener('pointermove', (e) => {
      hovered = pick(e);
      dom.style.cursor = hovered >= 0 ? 'pointer' : '';
      if (hovered >= 0) {
        const r = viewport.getBoundingClientRect();
        tooltip.show(zoneTip(hovered), e.clientX - r.left, e.clientY - r.top);
      } else tooltip.hide();
    });
    dom.addEventListener('pointerleave', () => {
      hovered = -1;
      tooltip.hide();
    });
    dom.addEventListener('pointerdown', () => (downAt = performance.now()));
    dom.addEventListener('pointerup', (e) => {
      if (performance.now() - downAt > 250) return; // 드래그 회전은 선택으로 치지 않는다.
      selected = pick(e);
      outline.selectedObjects = selected >= 0 ? [zoneMeshes[selected]] : [];
      renderDetail();
    });

    const res = () => sim[state.scenario];
    const zoneTip = (i: number) => {
      const z = zones[i];
      const s = state.step;
      return `<b>${z.name}</b><br>${res().temp[i][s].toFixed(1)}℃ · 재실 ${Math.round(sim.occ[i][s] * 100)}% · ${(res().power[i][s] / 1000).toFixed(1)} kW`;
    };

    function renderDetail() {
      if (selected < 0) {
        detail.innerHTML = '<p class="muted">건물 안의 존을 눌러 고른다.</p>';
        return;
      }
      const z = zones[selected];
      const eb = sumKwh(sim.baseline.power[selected]);
      const ea = sumKwh(sim.ai.power[selected]);
      detail.innerHTML = `<b>${z.name}</b> <span class="muted">${z.id} · ${z.area}㎡</span>
        <div class="kv"><span>하루 냉방 전력</span><span>${eb.toFixed(0)} → <em>${ea.toFixed(0)} kWh</em></span></div>
        <div class="kv"><span>존 절감률</span><span><em>${(((eb - ea) / eb) * 100).toFixed(1)}%</em></span></div>
        ${z.dataGap ? `<div class="warn">${fmtTime(z.dataGap[0])}~${fmtTime(z.dataGap[1])} 센서 결측 구간이 있다. 이 구간은 시뮬레이션 보간값으로 제어를 이어 간다.</div>` : ''}
        <div class="chart-legend"><span class="b">고정 스케줄 ℃</span><span class="a">AI 제어 ℃</span><span class="g">쾌적 범위</span></div>`;
      detail.appendChild(spark);
    }

    // ── 매 프레임 ─────────────────────────────────────────────────
    const tmp = new THREE.Color();
    const v = new THREE.Vector3();
    stage.onFrame((dt, t) => {
      if (state.playing) {
        stepF = (stepF + dt * 12 * state.speed) % STEPS; // 1초에 1시간
        state.step = Math.floor(stepF);
        range.value = String(state.step);
      }
      const s = state.step;
      const r = res();

      // 층 분리·층 고립
      floors.forEach((g, f) => {
        const target = g.userData.baseY * (1 + state.explode);
        g.position.y += (target - g.position.y) * Math.min(1, dt * 8);
        g.visible = state.floor < 0 || state.floor === f || state.explode > 0.05 || f < state.floor;
      });
      roof.position.y += (roof.userData.baseY * (1 + state.explode) - roof.position.y) * Math.min(1, dt * 8);
      roof.visible = state.floor < 0;

      // 존 색
      zoneMeshes.forEach((m, i) => {
        const z = zones[i];
        const occ = sim.occ[i][s];
        const T = r.temp[i][s];
        let x = 0;
        if (state.mode === 'temp') x = (T - 22) / 8;
        else if (state.mode === 'occ') x = occ;
        else if (state.mode === 'power') x = r.power[i][s] / z.area / 40;
        else x = occ > 0.2 ? Math.max(COMFORT.min - T, T - COMFORT.max, 0) / 3 : 0;
        sampleRamp(MODE_RAMP[state.mode], x, tmp);
        const inGap = z.dataGap && s >= z.dataGap[0] && s <= z.dataGap[1];
        if (inGap) tmp.lerp(new THREE.Color(0x777777), 0.55);
        m.material.color.copy(tmp);
        const focus = state.floor < 0 || state.floor === z.floor;
        m.material.opacity = focus ? (state.mode === 'comfort' && occ <= 0.2 ? 0.25 : 0.82) : 0.06;
        m.material.emissive.copy(tmp).multiplyScalar(i === hovered ? 0.55 : i === selected ? 0.3 : 0.12);
      });
      gapMarks.forEach(({ z, o }) => (o.visible = !!z.dataGap && s >= z.dataGap[0] && s <= z.dataGap[1] && (state.floor < 0 || state.floor === z.floor)));

      // 팬 회전 속도 = 건물 전력
      const load = r.totalPower[s] / maxKw;
      fans.forEach((f) => (f.rotation.y += dt * 18 * load));

      // 급기 입자
      zones.forEach((z, i) => {
        const p = pathOf(z, state.explode);
        const share = r.power[i][s] / (z.area * 40);
        const active = share > 0.02 && (state.floor < 0 || state.floor === z.floor);
        for (let k = 0; k < PER_ZONE; k++) {
          const idx = i * PER_ZONE + k;
          if (!active) {
            flowPos.set([p[0].x, p[0].y - 1, p[0].z], idx * 3); // 공조기 안에 숨긴다.
            continue;
          }
          flowU[idx] = (flowU[idx] + dt * (0.15 + share * 0.6)) % 1;
          along(p, flowU[idx], v);
          flowPos.set([v.x, v.y, v.z], idx * 3);
        }
      });
      flowGeo.attributes.position.needsUpdate = true;

      // 지표
      const pb = sim.baseline.totalPower[s];
      const pa = sim.ai.totalPower[s];
      const eb = sim.baseline.cumEnergy[s];
      const ea = sim.ai.cumEnergy[s];
      clockEl.textContent = fmtTime(s);
      kpi.innerHTML = `
        <div class="kv"><span>시각 · 외기</span><span>${fmtTime(s)} · ${sim.outdoor[s].toFixed(1)}℃</span></div>
        <div class="kv"><span>현재 전력</span><span>${pb.toFixed(0)} → <em>${pa.toFixed(0)} kW</em></span></div>
        <div class="kv"><span>누적 전력량</span><span>${eb.toFixed(0)} → <em>${ea.toFixed(0)} kWh</em></span></div>
        <div class="kv big"><span>하루 절감률</span><span><em>${((1 - sim.ai.energy / sim.baseline.energy) * 100).toFixed(1)}%</em></span></div>
        <div class="kv"><span>쾌적 유지율</span><span>${(sim.baseline.comfort * 100).toFixed(1)}% → <em>${(sim.ai.comfort * 100).toFixed(1)}%</em></span></div>`;
      if (Math.floor(t * 10) % 2 === 0) {
        drawChart(chart, [
          { data: outdoorScaled, color: 'rgba(250, 204, 21, 0.45)', dash: [3, 3], width: 1 },
          { data: sim.baseline.totalPower, color: '#94a3b8' },
          { data: sim.ai.totalPower, color: '#38bdf8', width: 2 },
        ], { min: 0, max: maxKw, cursor: s, yTicks: [0, Math.round(maxKw / 2 / 50) * 50], unit: '' });
        if (selected >= 0) {
          const z = zones[selected];
          drawChart(spark, [
            { data: sim.baseline.temp[selected], color: '#94a3b8' },
            { data: sim.ai.temp[selected], color: '#38bdf8', width: 2 },
          ], { min: 21, max: 31, cursor: s, band: [COMFORT.min, COMFORT.max], gaps: z.dataGap ? [z.dataGap] : [], yTicks: [22, 26, 30], unit: '℃' });
        }
      }
      if (hovered >= 0) tooltip.show(zoneTip(hovered), ...tooltipPos());
    });
    let lastTip: [number, number] = [0, 0];
    viewport.addEventListener('pointermove', (e) => {
      const r = viewport.getBoundingClientRect();
      lastTip = [e.clientX - r.left, e.clientY - r.top];
    });
    const tooltipPos = () => lastTip;

    return () => {
      composer.dispose();
      stage.dispose();
    };
  },
};

function sumKwh(p: Float32Array): number {
  let s = 0;
  for (const x of p) s += x;
  return (s * 300) / 3.6e6;
}

/** 꺾은선 경로 위의 u(0..1) 위치 */
function along(p: THREE.Vector3[], u: number, out: THREE.Vector3): THREE.Vector3 {
  const lens = p.slice(1).map((q, i) => q.distanceTo(p[i]));
  let d = u * lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]) return out.lerpVectors(p[i], p[i + 1], d / lens[i]);
    d -= lens[i];
  }
  return out.copy(p[p.length - 1]);
}

let dotTex: THREE.Texture | null = null;
/** 입자용 원형 스프라이트. 이미지 파일 없이 캔버스로 만든다. */
export function dotTexture(): THREE.Texture {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  dotTex = new THREE.CanvasTexture(c);
  dotTex.colorSpace = THREE.SRGBColorSpace;
  return dotTex;
}
