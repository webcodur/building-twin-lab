import * as THREE from 'three';
import { createStage } from '../core/stage';
import { Panel, createTooltip } from '../core/panel';
import { RAMPS, sampleRamp } from '../core/colormap';
import { layout, type Lab } from './types';

/**
 * 포트폴리오·도시 규모: 수만 동을 InstancedMesh 한 번의 draw call로 그린다.
 * 실시간 부하 모드는 CPU가 아니라 셰이더에서 인스턴스별 위상으로 색을 움직인다.
 */

const USES = {
  office: { name: '업무', color: 0x60a5fa, eui: 230 },
  residential: { name: '주거', color: 0x34d399, eui: 150 },
  retail: { name: '판매', color: 0xf472b6, eui: 320 },
  school: { name: '교육', color: 0xfbbf24, eui: 170 },
} as const;
type Use = keyof typeof USES;
const USE_KEYS = Object.keys(USES) as Use[];

interface Bldg {
  x: number;
  z: number;
  w: number;
  d: number;
  floors: number;
  use: Use;
  year: number;
  eui: number; // kWh/㎡·년
  ai: boolean;
  saving: number; // AI 적용 시 절감률
}

type Mode = 'eui' | 'use' | 'ai' | 'live';

export const portfolioLab: Lab = {
  id: 'portfolio',
  title: '포트폴리오·도시 규모',
  tag: '확장성',
  summary: '수만 동의 건물을 한 번의 draw call로 그린다. 에너지 원단위·용도·AI 적용 여부로 칠하고, 실시간 부하는 GPU에서 움직인다.',
  mount(el) {
    const { viewport, side } = layout(el);
    const stage = createStage(viewport, { background: 0x070b16 });
    const { scene, camera, controls, renderer } = stage;
    scene.fog = new THREE.Fog(0x070b16, 250, 900);
    camera.position.set(260, 220, 300);
    camera.far = 3000;
    camera.updateProjectionMatrix();
    scene.add(new THREE.HemisphereLight(0xc7d2fe, 0x0f172a, 0.9));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(200, 300, 100);
    scene.add(dl);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0b1222, roughness: 1 }));
    scene.add(ground);

    const uniforms = { uTime: { value: 0 }, uLive: { value: 0 } };
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
    // 표준 재질 셰이더에 몇 줄만 끼워 넣어 조명·그림자·안개는 그대로 쓰고 색만 바꾼다.
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPhase;\nattribute float aBase;\nuniform float uTime;\nvarying float vLoad;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLoad = clamp(aBase * (0.65 + 0.35 * sin(uTime * 1.3 + aPhase)), 0.0, 1.0);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uLive;\nvarying float vLoad;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          if (uLive > 0.5) {
            vec3 lo = vec3(0.02, 0.15, 0.35), mid = vec3(0.1, 0.75, 0.6), hi = vec3(1.0, 0.25, 0.1);
            diffuseColor.rgb = vLoad < 0.5 ? mix(lo, mid, vLoad * 2.0) : mix(mid, hi, vLoad * 2.0 - 1.0);
          }`,
        );
    };

    let mesh: THREE.InstancedMesh | null = null;
    let data: Bldg[] = [];
    const state = { count: 20000, mode: 'eui' as Mode, minEui: 0, hovered: -1, selected: -1 };

    function generate(n: number): Bldg[] {
      let seed = 42;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const out: Bldg[] = [];
      const side = Math.ceil(Math.sqrt(n / 4));
      const BLOCK = 34;
      for (let bi = 0; bi < side && out.length < n; bi++)
        for (let bj = 0; bj < side && out.length < n; bj++) {
          // 블록 하나에 2×2 필지. 도심(원점)에 가까울수록 높다.
          const cx = (bi - side / 2) * BLOCK;
          const cz = (bj - side / 2) * BLOCK;
          const dist = Math.hypot(cx, cz) / (side * BLOCK * 0.5);
          for (let k = 0; k < 4 && out.length < n; k++) {
            const use: Use = dist < 0.25 && rnd() < 0.6 ? (rnd() < 0.8 ? 'office' : 'retail') : USE_KEYS[Math.floor(rnd() * 4)];
            const tall = Math.max(1, Math.round((1 - dist) ** 3 * 40 * rnd() + 2 + rnd() * 4));
            const year = Math.round(1970 + rnd() * 55);
            const age = (2026 - year) / 55;
            const eui = USES[use].eui * (0.7 + age * 0.6) * (0.8 + rnd() * 0.4);
            const ai = rnd() < 0.18;
            out.push({
              x: cx + (k % 2 ? 7.5 : -7.5) + (rnd() - 0.5) * 2,
              z: cz + (k < 2 ? 7.5 : -7.5) + (rnd() - 0.5) * 2,
              w: 8 + rnd() * 5,
              d: 8 + rnd() * 5,
              floors: use === 'residential' ? Math.max(tall, 5) : tall,
              use,
              year,
              eui,
              ai,
              saving: ai ? 0.12 + rnd() * 0.18 : 0,
            });
          }
        }
      return out;
    }

    function build() {
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.dispose();
      }
      data = generate(state.count);
      const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const phase = new Float32Array(data.length);
      const base = new Float32Array(data.length);
      data.forEach((b, i) => {
        phase[i] = (b.x * 0.05 + b.z * 0.03) % (Math.PI * 2) + i * 0.618;
        base[i] = Math.min(1, b.eui / 380);
      });
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
      geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 1));
      mesh = new THREE.InstancedMesh(geo, mat, data.length);
      const m = new THREE.Matrix4();
      data.forEach((b, i) => mesh!.setMatrixAt(i, m.makeScale(b.w, b.floors * 3.3, b.d).setPosition(b.x, 0, b.z)));
      mesh.instanceMatrix.needsUpdate = true;
      // 인스턴스 전체를 감싸는 경계 구를 다시 계산해야 화면 밖 판정(frustum culling)이 맞다.
      mesh.computeBoundingSphere();
      scene.add(mesh);
      recolor();
    }

    const col = new THREE.Color();
    const dim = new THREE.Color(0x1e293b);
    function recolor() {
      if (!mesh) return;
      uniforms.uLive.value = state.mode === 'live' ? 1 : 0;
      data.forEach((b, i) => {
        if (state.mode === 'eui') sampleRamp(RAMPS.status, (b.eui - 100) / 300, col);
        else if (state.mode === 'use') col.setHex(USES[b.use].color);
        else if (state.mode === 'ai') col.setHex(b.ai ? 0x22d3ee : 0x334155);
        else col.setHex(0xffffff);
        if (b.eui < state.minEui) col.copy(dim);
        if (i === state.hovered || i === state.selected) col.setHex(0xffffff);
        mesh!.setColorAt(i, col);
      });
      mesh.instanceColor!.needsUpdate = true;
      renderSummary();
    }

    // ── 패널 ──────────────────────────────────────────────────────
    const panel = new Panel(side, '포트폴리오·도시 규모', '가상 도시의 건물 전부를 인스턴싱 한 번으로 그렸다. 건물을 누르면 그 건물로 날아간다.');
    panel.section('규모');
    panel.select('건물 수', { 1000: '1,000동', 5000: '5,000동', 20000: '20,000동', 50000: '50,000동', 100000: '100,000동' } as Record<string, string>, '20000', (v) => {
      state.count = Number(v);
      state.selected = state.hovered = -1;
      build();
    });
    panel.section('보기');
    panel.segmented('색', { eui: '원단위', use: '용도', ai: 'AI 적용', live: '실시간 부하' } as Record<Mode, string>, state.mode, (v) => {
      state.mode = v;
      recolor();
      renderLegend();
    });
    const legendBox = panel.info();
    panel.slider('원단위 이상만', { min: 0, max: 400, step: 10, value: 0, format: (v) => (v ? `${v}+` : '전체') }, (v) => {
      state.minEui = v;
      recolor();
    });
    panel.section('요약');
    const summary = panel.info();
    panel.section('선택한 건물');
    const detail = panel.info();
    detail.innerHTML = '<p class="muted">건물을 누른다.</p>';
    panel.section('렌더링');
    const perf = panel.info('stats');

    function renderLegend() {
      legendBox.innerHTML = '';
      if (state.mode === 'eui') legendBox.appendChild(panel.legend(RAMPS.status, '100', '400 kWh/㎡·년'));
      else if (state.mode === 'use')
        legendBox.innerHTML = `<div class="chart-legend">${USE_KEYS.map((k) => `<span style="color:#${USES[k].color.toString(16)}">${USES[k].name}</span>`).join('')}</div>`;
      else if (state.mode === 'ai') legendBox.innerHTML = '<div class="chart-legend"><span style="color:#22d3ee">AI 제어 적용</span><span style="color:#64748b">미적용</span></div>';
      else legendBox.innerHTML = '<p class="muted">인스턴스별 위상으로 GPU가 직접 색을 움직인다. CPU 갱신이 0이다.</p>';
    }

    function renderSummary() {
      let area = 0, energy = 0, aiN = 0, saved = 0;
      for (const b of data) {
        const a = b.w * b.d * b.floors;
        area += a;
        energy += a * b.eui;
        if (b.ai) {
          aiN++;
          saved += a * b.eui * b.saving;
        }
      }
      summary.innerHTML = `
        <div class="kv"><span>연면적</span><span>${(area / 1e6).toFixed(2)} km²</span></div>
        <div class="kv"><span>연간 에너지</span><span>${(energy / 1e9).toFixed(2)} TWh</span></div>
        <div class="kv"><span>AI 적용 건물</span><span>${aiN.toLocaleString()}동 (${((aiN / data.length) * 100).toFixed(0)}%)</span></div>
        <div class="kv"><span>적용분 절감</span><span><em>${(saved / 1e6).toFixed(0)} GWh/년</em></span></div>
        <div class="kv"><span>전체 적용 시 추정</span><span><em>${((energy * 0.2) / 1e9).toFixed(2)} TWh/년</em></span></div>`;
    }

    function renderDetail() {
      const b = data[state.selected];
      if (!b) {
        detail.innerHTML = '<p class="muted">건물을 누른다.</p>';
        return;
      }
      const a = b.w * b.d * b.floors;
      detail.innerHTML = `
        <div class="kv"><span>용도 · 준공</span><span>${USES[b.use].name} · ${b.year}년</span></div>
        <div class="kv"><span>층수 · 연면적</span><span>${b.floors}층 · ${a.toFixed(0)} ㎡</span></div>
        <div class="kv"><span>에너지 원단위</span><span>${b.eui.toFixed(0)} kWh/㎡·년</span></div>
        <div class="kv"><span>AI 제어</span><span>${b.ai ? `<em>적용 · ${(b.saving * 100).toFixed(0)}% 절감</em>` : '미적용'}</span></div>
        <a class="btn" href="#/twin">이 건물의 디지털 트윈 열기 →</a>`;
    }

    // ── 상호작용 ──────────────────────────────────────────────────
    const tip = createTooltip(viewport);
    const ray = new THREE.Raycaster();
    let pending: PointerEvent | null = null;
    const dom = stage.labels.domElement;
    dom.addEventListener('pointermove', (e) => (pending = e)); // 프레임당 한 번만 피킹한다.
    let downAt = 0;
    dom.addEventListener('pointerdown', () => (downAt = performance.now()));
    dom.addEventListener('pointerup', () => {
      if (performance.now() - downAt > 250 || state.hovered < 0) return;
      state.selected = state.hovered;
      const b = data[state.selected];
      flyTo.set(b.x, (b.floors * 3.3) / 2, b.z);
      // 건물 높이에 비례해 물러서야 주변 고층에 가리지 않는다.
      const back = 60 + b.floors * 3.3 * 1.6;
      offset.set(back * 0.7, back * 0.9, back);
      flyT = 0;
      renderDetail();
      recolor();
    });

    const flyTo = new THREE.Vector3();
    let flyT = 1;
    const fromTarget = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const fromCam = new THREE.Vector3();

    let fpsAcc = 0, fpsN = 0, fps = 0;
    stage.onFrame((dt, t) => {
      uniforms.uTime.value = t;
      if (pending && mesh) {
        ray.setFromCamera(stage.toNdc(pending), camera);
        const hit = ray.intersectObject(mesh)[0];
        const id = hit?.instanceId ?? -1;
        if (id !== state.hovered) {
          state.hovered = id;
          recolor();
        }
        const r = viewport.getBoundingClientRect();
        if (id >= 0) {
          const b = data[id];
          tip.show(`<b>${USES[b.use].name} · ${b.floors}층</b><br>${b.eui.toFixed(0)} kWh/㎡·년${b.ai ? ' · AI 적용' : ''}`, pending.clientX - r.left, pending.clientY - r.top);
        } else tip.hide();
        dom.style.cursor = id >= 0 ? 'pointer' : '';
        pending = null;
      }
      if (flyT < 1) {
        if (flyT === 0) {
          fromTarget.copy(controls.target);
          fromCam.copy(camera.position);
        }
        flyT = Math.min(1, flyT + dt * 0.9);
        const k = 1 - Math.pow(1 - flyT, 3);
        controls.target.lerpVectors(fromTarget, flyTo, k);
        camera.position.lerpVectors(fromCam, flyTo.clone().add(offset), k);
      }
      fpsAcc += dt;
      fpsN++;
      if (fpsAcc > 0.5) {
        fps = fpsN / fpsAcc;
        fpsAcc = fpsN = 0;
        const info = renderer.info.render;
        perf.innerHTML = `FPS ${fps.toFixed(0)}<br>draw calls ${info.calls}<br>삼각형 ${info.triangles.toLocaleString()}<br>인스턴스 ${data.length.toLocaleString()}`;
      }
    });

    build();
    renderLegend();
    return () => {
      mesh?.geometry.dispose();
      mat.dispose();
      stage.dispose();
    };
  },
};
