import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { createStage } from '../core/stage';
import { Panel } from '../core/panel';
import { RAMPS, rampCss } from '../core/colormap';
import { disposeObject } from '../core/dispose';
import { layout, type Lab } from './types';

/**
 * 포인트클라우드 → 벽체 모델 자동 추출.
 * 실제 PoC의 "스캔/도면 → 건물 모델 → 에너지 시뮬레이션 입력" 파이프라인 앞단을 브라우저에서 보여 준다.
 */

interface Cloud {
  pos: Float32Array;
  col: Float32Array;
}

interface Segment {
  axis: 'x' | 'z';
  a: number; // 축 방향 시작
  b: number; // 축 방향 끝
  c: number; // 직교 좌표
}

interface Recon {
  floorY: number;
  ceilY: number;
  segments: Segment[];
  floorArea: number;
  cls: Float32Array; // 0 기타, 1 바닥, 2 천장, 3 벽
  ms: number;
}

const CLASS_COLORS = [0xf59e0b, 0x22c55e, 0x60a5fa, 0xf472b6];
const CLASS_NAMES = ['가구·기타', '바닥', '천장', '벽'];

export const scanLab: Lab = {
  id: 'scan',
  title: '포인트클라우드 → 3D 벽체',
  tag: '건물 DX 자동화',
  summary: '실내 스캔 점군에서 바닥·천장·벽을 자동으로 찾아 벽체 모델과 면적·체적을 뽑는다. .ply·.pcd·.xyz 파일을 끌어다 놓아도 된다.',
  mount(el) {
    const { viewport, side } = layout(el);
    viewport.classList.add('dropzone');
    const stage = createStage(viewport, { background: 0x05070f, environment: false });
    const { scene, camera, controls, renderer } = stage;
    camera.position.set(9, 12, 13);
    controls.target.set(0, 1, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.5);
    dl.position.set(5, 10, 3);
    scene.add(dl);
    const grid = new THREE.GridHelper(40, 40, 0x1e293b, 0x111827);
    grid.position.y = -0.01;
    scene.add(grid);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '.ply · .pcd · .xyz 파일을 여기에 끌어다 놓으면 실제 스캔으로 바꾼다';
    viewport.appendChild(hint);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: 2.2 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uClipY: { value: 99 },
        uReveal: { value: 0 },
        uMode: { value: 0 },
        uHeight: { value: new THREE.Vector2(0, 2.7) },
        uClassColors: { value: CLASS_COLORS.map((c) => new THREE.Color(c)) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aReveal;
        attribute float aClass;
        uniform float uSize, uPixelRatio, uClipY, uReveal, uMode;
        uniform vec2 uHeight;
        uniform vec3 uClassColors[4];
        varying vec3 vColor;
        varying float vKeep;
        vec3 ramp(float t) {
          // 파랑 → 청록 → 노랑 → 빨강. sRGB 값을 선형으로 바꿔 쓴다.
          vec3 c = t < 0.33 ? mix(vec3(0.17,0.48,0.71), vec3(0.0,0.65,0.79), t / 0.33)
                 : t < 0.66 ? mix(vec3(0.0,0.65,0.79), vec3(0.98,0.82,0.34), (t - 0.33) / 0.33)
                 : mix(vec3(0.98,0.82,0.34), vec3(0.84,0.1,0.11), (t - 0.66) / 0.34);
          return pow(c, vec3(2.2));
        }
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // 원근에 따라 점 크기를 줄인다(가까울수록 크게).
          gl_PointSize = uSize * uPixelRatio * (6.0 / -mv.z);
          vKeep = step(aReveal, uReveal) * step(position.y, uClipY);
          float h = clamp((position.y - uHeight.x) / (uHeight.y - uHeight.x), 0.0, 1.0);
          int k = int(aClass + 0.5);
          vColor = uMode < 0.5 ? aColor : uMode < 1.5 ? ramp(h) : uClassColors[k];
          // 막 드러난 점은 잠깐 밝게 빛나 스캔 파면을 만든다.
          vColor += vec3(0.4, 0.8, 1.0) * smoothstep(0.06, 0.0, uReveal - aReveal) * step(uReveal, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vKeep;
        void main() {
          if (vKeep < 0.5) discard;
          vec2 c = gl_PointCoord - 0.5;
          if (dot(c, c) > 0.25) discard;
          gl_FragColor = vec4(vColor, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });

    let points: THREE.Points | null = null;
    let cloud: Cloud = syntheticApartment();
    let recon: Recon | null = null;
    const walls = new THREE.Group();
    scene.add(walls);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.35, depthWrite: false, roughness: 0.7 });
    const wallEdge = new THREE.LineBasicMaterial({ color: 0x38bdf8 });
    let revealT = 0;

    function setCloud(c: Cloud) {
      cloud = c;
      recon = null;
      clearWalls();
      if (points) {
        scene.remove(points);
        points.geometry.dispose();
      }
      const n = c.pos.length / 3;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(c.pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(c.col, 3));
      g.setAttribute('aClass', new THREE.BufferAttribute(new Float32Array(n), 1));
      // 스캐너 위치(원점)에서의 거리로 드러나는 순서를 정한다.
      const reveal = new Float32Array(n);
      let maxD = 0;
      for (let i = 0; i < n; i++) {
        reveal[i] = Math.hypot(c.pos[i * 3], c.pos[i * 3 + 1] - 1.4, c.pos[i * 3 + 2]);
        maxD = Math.max(maxD, reveal[i]);
      }
      for (let i = 0; i < n; i++) reveal[i] = (reveal[i] / maxD) * 0.97 + Math.random() * 0.03;
      g.setAttribute('aReveal', new THREE.BufferAttribute(reveal, 1));
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      material.uniforms.uHeight.value.set(bb.min.y, bb.max.y);
      clipInput.max = String(bb.max.y + 0.05);
      clipInput.value = clipInput.max;
      material.uniforms.uClipY.value = 99;
      clipInput.dispatchEvent(new Event('sync'));
      points = new THREE.Points(g, material);
      scene.add(points);
      revealT = 0;
      renderStats();
    }

    function clearWalls() {
      disposeObject(walls);
      walls.clear();
    }

    function runRecon() {
      if (!points) return;
      recon = reconstruct(cloud.pos);
      (points.geometry.attributes.aClass as THREE.BufferAttribute).copyArray(recon.cls).needsUpdate = true;
      clearWalls();
      const h = recon.ceilY - recon.floorY;
      for (const s of recon.segments) {
        const len = s.b - s.a;
        const geo = new THREE.BoxGeometry(s.axis === 'x' ? len : 0.14, h, s.axis === 'x' ? 0.14 : len);
        const m = new THREE.Mesh(geo, wallMat);
        const mid = (s.a + s.b) / 2;
        m.position.set(s.axis === 'x' ? mid : s.c, recon.floorY + h / 2, s.axis === 'x' ? s.c : mid);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), wallEdge);
        m.add(e);
        walls.add(m);
      }
      walls.visible = showWalls.checked;
      renderStats();
    }

    // ── 패널 ──────────────────────────────────────────────────────
    const panel = new Panel(side, '포인트클라우드 → 3D 벽체', '가상 실내 스캔을 불러 바닥·천장·벽을 찾아 낸다. 맨해튼 가정(벽이 x·z축과 나란하다)을 쓴다.');
    panel.section('표시');
    panel.segmented('색', { 0: '스캔 색', 1: '높이', 2: '분류' } as Record<string, string>, '0', (v) => (material.uniforms.uMode.value = Number(v)));
    const legendEl = panel.info();
    panel.slider('점 크기', { min: 0.5, max: 6, step: 0.1, value: 2.2 }, (v) => (material.uniforms.uSize.value = v));
    const clipInput = panel.slider('높이 자르기', { min: 0, max: 3, step: 0.01, value: 3, format: (v) => `${v.toFixed(2)} m` }, (v) => (material.uniforms.uClipY.value = v));
    const showWalls = panel.toggle('벽체 표시', true, (v) => (walls.visible = v));
    panel.section('처리');
    panel.button('벽 추출 실행', runRecon, true);
    panel.button('스캔 다시 재생', () => (revealT = 0));
    panel.button('가상 스캔으로 되돌리기', () => setCloud(syntheticApartment()));
    const zup = panel.toggle('Z-up 파일', true, () => {});
    panel.section('결과');
    const stats = panel.info();

    const renderLegend = (mode: number) => {
      legendEl.innerHTML =
        mode === 2
          ? `<div class="chart-legend">${CLASS_NAMES.map((n, i) => `<span style="color:#${CLASS_COLORS[i].toString(16).padStart(6, '0')}">${n}</span>`).join('')}</div>`
          : mode === 1
            ? `<div class="legend"><div class="bar" style="background:${rampCss(RAMPS.thermal)}"></div><div class="ends"><span>바닥</span><span>천장</span></div></div>`
            : '';
    };
    side.querySelectorAll('.seg button').forEach((b, i) => b.addEventListener('click', () => renderLegend(i)));

    function renderStats() {
      const n = cloud.pos.length / 3;
      let html = `<div class="kv"><span>점 개수</span><span>${n.toLocaleString()}</span></div>`;
      if (recon) {
        const h = recon.ceilY - recon.floorY;
        const wallLen = recon.segments.reduce((a, s) => a + (s.b - s.a), 0);
        html += `
          <div class="kv"><span>처리 시간</span><span>${recon.ms.toFixed(0)} ms</span></div>
          <div class="kv"><span>바닥 · 천장 높이</span><span>${recon.floorY.toFixed(2)} · ${recon.ceilY.toFixed(2)} m</span></div>
          <div class="kv"><span>추출한 벽</span><span><em>${recon.segments.length}개</em> · ${wallLen.toFixed(1)} m</span></div>
          <div class="kv"><span>바닥 면적</span><span><em>${recon.floorArea.toFixed(1)} ㎡</em></span></div>
          <div class="kv"><span>벽 면적(개구부 포함)</span><span>${(wallLen * h).toFixed(1)} ㎡</span></div>
          <div class="kv"><span>실 체적</span><span>${(recon.floorArea * h).toFixed(1)} ㎥</span></div>
          <p class="muted" style="margin-top:10px">이 값들이 에너지 시뮬레이션의 입력(공조 면적·체적·외피 면적)이 된다.</p>`;
      } else html += '<p class="muted">「벽 추출 실행」을 누른다.</p>';
      stats.innerHTML = html;
    }

    // ── 파일 끌어다 놓기 ───────────────────────────────────────────
    viewport.addEventListener('dragover', (e) => {
      e.preventDefault();
      viewport.classList.add('over');
    });
    viewport.addEventListener('dragleave', () => viewport.classList.remove('over'));
    viewport.addEventListener('drop', async (e) => {
      e.preventDefault();
      viewport.classList.remove('over');
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      hint.textContent = `${file.name} 읽는 중…`;
      try {
        setCloud(normalize(await loadCloudFile(file), zup.checked));
        hint.textContent = `${file.name} · 「벽 추출 실행」으로 처리한다`;
      } catch (err) {
        hint.textContent = `읽지 못했다: ${(err as Error).message}`;
      }
    });

    stage.onFrame((dt) => {
      if (revealT <= 1.05) {
        revealT += dt * 0.45;
        material.uniforms.uReveal.value = revealT;
      }
    });

    setCloud(cloud);
    renderLegend(0);

    return () => {
      points?.geometry.dispose();
      material.dispose();
      stage.dispose();
    };
  },
};

// ── 가상 스캔 생성 ──────────────────────────────────────────────────

type Wall = { a: [number, number]; b: [number, number]; doors?: Array<[number, number]>; windows?: Array<[number, number]>; both?: boolean };

const H = 2.7;

function syntheticApartment(): Cloud {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const density = 420; // 점/㎡
  const jitter = () => (Math.random() - 0.5) * 0.012;
  const push = (x: number, y: number, z: number, hex: number, v = 0.06) => {
    pos.push(x - 6 + jitter(), y + jitter(), z - 5 + jitter());
    c.setHex(hex);
    const k = 1 + (Math.random() - 0.5) * v * 2;
    col.push(c.r * k, c.g * k, c.b * k);
  };

  const walls: Wall[] = [
    { a: [0, 0], b: [12, 0], windows: [[1, 3], [8.5, 10.5]] },
    { a: [12, 0], b: [12, 6], windows: [[2, 4]] },
    { a: [12, 6], b: [7, 6] },
    { a: [7, 6], b: [7, 10] },
    { a: [7, 10], b: [0, 10], windows: [[4, 5.5]] },
    { a: [0, 10], b: [0, 0], windows: [[3, 5]] },
    { a: [7, 0], b: [7, 6], doors: [[2, 2.9]], both: true },
    { a: [0, 6], b: [7, 6], doors: [[4.5, 5.4]], both: true },
    { a: [3.5, 6], b: [3.5, 10], doors: [[0.4, 1.2]], both: true },
  ];

  for (const w of walls) {
    const [ax, az] = w.a;
    const [bx, bz] = w.b;
    const len = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    const n = Math.round(len * H * density);
    const faces = w.both ? [-0.06, 0.06] : [0];
    for (let i = 0; i < n; i++) {
      const t = Math.random() * len;
      const y = Math.random() * H;
      if (w.doors?.some(([s, e]) => t > s && t < e && y < 2.1)) continue;
      if (w.windows?.some(([s, e]) => t > s && t < e && y > 0.9 && y < 2.1)) continue;
      const off = faces[i % faces.length];
      push(ax + dx * t - dz * off, y, az + dz * t + dx * off, 0xd6d3cd);
    }
  }

  const inside = (x: number, z: number) => !(x > 7 && z > 6);
  const area = 12 * 10;
  for (let i = 0; i < area * density; i++) {
    const x = Math.random() * 12;
    const z = Math.random() * 10;
    if (!inside(x, z)) continue;
    push(x, 0, z, 0x9a6b43, 0.12); // 마루
    if (i % 2 === 0) push(x, H, z, 0xf1f1ee); // 천장은 절반 밀도
  }

  const boxes: Array<[number, number, number, number, number, number]> = [
    [1, 1, 3.2, 1.9, 0.8, 0x4b5563], // 소파
    [4, 2.5, 5.5, 3.5, 0.75, 0x7c4a2d], // 탁자
    [8.5, 2, 11, 4.2, 0.55, 0xe5e7eb], // 침대
    [11.35, 4, 11.95, 5.8, 2.0, 0x8b7355], // 옷장
    [0.05, 9.35, 3.3, 9.95, 0.9, 0x9ca3af], // 주방 조리대
    [4.2, 7.2, 6.2, 8.4, 0.75, 0x6b4f3a], // 책상
  ];
  for (const [x0, z0, x1, z1, h, hex] of boxes) {
    const top = (x1 - x0) * (z1 - z0);
    for (let i = 0; i < top * density; i++) push(x0 + Math.random() * (x1 - x0), h, z0 + Math.random() * (z1 - z0), hex);
    const sides = 2 * ((x1 - x0) + (z1 - z0)) * h;
    for (let i = 0; i < sides * density; i++) {
      const y = Math.random() * h;
      const r = Math.random() * 2 * ((x1 - x0) + (z1 - z0));
      const wx = x1 - x0;
      const wz = z1 - z0;
      if (r < wx) push(x0 + r, y, z0, hex);
      else if (r < 2 * wx) push(x0 + r - wx, y, z1, hex);
      else if (r < 2 * wx + wz) push(x0, y, z0 + r - 2 * wx, hex);
      else push(x1, y, z0 + r - 2 * wx - wz, hex);
    }
  }
  return { pos: new Float32Array(pos), col: new Float32Array(col) };
}

// ── 재구성 알고리즘 ────────────────────────────────────────────────

function reconstruct(pos: Float32Array): Recon {
  const t0 = performance.now();
  const n = pos.length / 3;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // 1) 높이 히스토그램: 가장 낮은·높은 큰 봉우리를 바닥·천장으로 본다.
  const BIN = 0.05;
  const nb = Math.ceil((maxY - minY) / BIN) + 1;
  const hist = new Uint32Array(nb);
  for (let i = 0; i < n; i++) hist[Math.floor((pos[i * 3 + 1] - minY) / BIN)]++;
  const peak = Math.max(...hist);
  const firstBig = hist.findIndex((v) => v > peak * 0.3);
  let lastBig = nb - 1;
  while (lastBig > 0 && hist[lastBig] <= peak * 0.3) lastBig--;
  const floorY = minY + (firstBig + 0.5) * BIN;
  const ceilY = minY + (lastBig + 0.5) * BIN;

  // 2) 바닥·천장 사이 점을 평면 격자에 쌓는다. 벽은 세로로 길게 쌓이고 가구는 낮게 쌓인다.
  const CELL = 0.05;
  const gw = Math.ceil((maxX - minX) / CELL) + 1;
  const gh = Math.ceil((maxZ - minZ) / CELL) + 1;
  const cnt = new Uint16Array(gw * gh);
  const lo = new Float32Array(gw * gh).fill(Infinity);
  const hi = new Float32Array(gw * gh).fill(-Infinity);
  const yA = floorY + 0.3, yB = ceilY - 0.3;
  for (let i = 0; i < n; i++) {
    const y = pos[i * 3 + 1];
    if (y < yA || y > yB) continue;
    const k = Math.floor((pos[i * 3] - minX) / CELL) + Math.floor((pos[i * 3 + 2] - minZ) / CELL) * gw;
    cnt[k]++;
    if (y < lo[k]) lo[k] = y;
    if (y > hi[k]) hi[k] = y;
  }
  const need = (yB - yA) * 0.85;
  const wall = new Uint8Array(gw * gh);
  for (let k = 0; k < wall.length; k++) wall[k] = cnt[k] >= 4 && hi[k] - lo[k] >= need ? 1 : 0;

  // 3) 행·열 방향으로 연속된 벽 셀을 선분으로 뽑고, 이웃한 행끼리 합친다.
  const MIN_RUN = Math.round(0.5 / CELL);
  const extract = (axis: 'x' | 'z'): Segment[] => {
    const lines = axis === 'x' ? gh : gw;
    const len = axis === 'x' ? gw : gh;
    const at = (line: number, i: number) => (axis === 'x' ? wall[i + line * gw] : wall[line + i * gw]);
    type Group = { a: number; b: number; lines: number[]; last: number };
    const groups: Group[] = [];
    for (let line = 0; line < lines; line++) {
      let i = 0;
      while (i < len) {
        if (!at(line, i)) {
          i++;
          continue;
        }
        let j = i;
        let miss = 0;
        while (j + 1 < len && (at(line, j + 1) || (miss < 1 && at(line, j + 2)))) {
          miss = at(line, j + 1) ? 0 : miss + 1;
          j++;
        }
        if (j - i + 1 >= MIN_RUN) {
          const g = groups.find((g) => line - g.last <= 3 && Math.min(g.b, j) - Math.max(g.a, i) > 0.5 * Math.min(g.b - g.a, j - i));
          if (g) {
            g.a = Math.min(g.a, i);
            g.b = Math.max(g.b, j);
            g.lines.push(line);
            g.last = line;
          } else groups.push({ a: i, b: j, lines: [line], last: line });
        }
        i = j + 1;
      }
    }
    const o0 = axis === 'x' ? minX : minZ;
    const o1 = axis === 'x' ? minZ : minX;
    return groups.map((g) => ({
      axis,
      a: o0 + g.a * CELL,
      b: o0 + (g.b + 1) * CELL,
      c: o1 + (g.lines.reduce((s, v) => s + v, 0) / g.lines.length + 0.5) * CELL,
    }));
  };
  const segments = [...extract('x'), ...extract('z')];

  // 4) 점 분류 + 바닥 면적(10cm 격자 점유)
  const cls = new Float32Array(n);
  const FC = 0.1;
  const fw = Math.ceil((maxX - minX) / FC) + 1;
  const floorCells = new Uint8Array(fw * (Math.ceil((maxZ - minZ) / FC) + 1));
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (Math.abs(y - floorY) < 0.08) {
      cls[i] = 1;
      floorCells[Math.floor((x - minX) / FC) + Math.floor((z - minZ) / FC) * fw] = 1;
    } else if (Math.abs(y - ceilY) < 0.08) cls[i] = 2;
    else if (wall[Math.floor((x - minX) / CELL) + Math.floor((z - minZ) / CELL) * gw]) cls[i] = 3;
  }
  const floorArea = floorCells.reduce((a, v) => a + v, 0) * FC * FC;
  return { floorY, ceilY, segments, floorArea, cls, ms: performance.now() - t0 };
}

// ── 파일 읽기 ──────────────────────────────────────────────────────

async function loadCloudFile(file: File): Promise<Cloud> {
  const ext = file.name.split('.').pop()!.toLowerCase();
  const buf = await file.arrayBuffer();
  let geo: THREE.BufferGeometry;
  if (ext === 'ply') geo = new PLYLoader().parse(buf);
  else if (ext === 'pcd') geo = new PCDLoader().parse(buf).geometry;
  else if (ext === 'xyz' || ext === 'txt' || ext === 'csv') geo = parseXyz(new TextDecoder().decode(buf));
  else throw new Error('ply·pcd·xyz만 읽는다');
  const p = geo.attributes.position.array as Float32Array;
  const c = geo.attributes.color?.array as Float32Array | undefined;
  return { pos: new Float32Array(p), col: c ? new Float32Array(c) : new Float32Array(p.length).fill(0.75) };
}

function parseXyz(text: string): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  for (const line of text.split('\n')) {
    const v = line.trim().split(/[\s,;]+/).map(Number);
    if (v.length < 3 || v.slice(0, 3).some(Number.isNaN)) continue;
    pos.push(v[0], v[1], v[2]);
    if (v.length >= 6) {
      const s = v[3] > 1 || v[4] > 1 || v[5] > 1 ? 255 : 1;
      col.push(v[3] / s, v[4] / s, v[5] / s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (col.length === pos.length) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Z-up → Y-up 변환, 바닥을 y=0에 놓고 수평 중심을 원점으로 옮긴다. 너무 크면 솎아 낸다. */
function normalize(c: Cloud, zUp: boolean): Cloud {
  const MAX = 1_500_000;
  const n = c.pos.length / 3;
  const stride = Math.max(1, Math.ceil(n / MAX));
  const m = Math.floor(n / stride);
  const pos = new Float32Array(m * 3);
  const col = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) {
    const s = i * stride * 3;
    const x = c.pos[s], y = c.pos[s + 1], z = c.pos[s + 2];
    pos.set(zUp ? [x, z, -y] : [x, y, z], i * 3);
    col.set([c.col[s], c.col[s + 1], c.col[s + 2]], i * 3);
  }
  const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(pos, 3));
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  for (let i = 0; i < m; i++) {
    pos[i * 3] -= cx;
    pos[i * 3 + 1] -= box.min.y;
    pos[i * 3 + 2] -= cz;
  }
  // 파일 색은 sRGB로 저장되어 있으므로 셰이더가 기대하는 선형 값으로 바꾼다.
  for (let i = 0; i < col.length; i++) col[i] = srgbToLinear(col[i]);
  return { pos, col };
}

const srgbToLinear = (c: number) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
