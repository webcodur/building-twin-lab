import * as THREE from 'three';

/** 색 정지점 배열로 0..1 값을 색으로 바꾼다. 셰이더 없이 CPU에서 정점·인스턴스 색을 칠할 때 쓴다. */
export type Ramp = ReadonlyArray<readonly [number, number]>; // [위치, 0xRRGGBB]

export const RAMPS = {
  /** 온도·부하: 파랑 → 청록 → 노랑 → 빨강 */
  thermal: [
    [0, 0x2c7bb6],
    [0.35, 0x00a6ca],
    [0.55, 0x90eb9d],
    [0.75, 0xf9d057],
    [1, 0xd7191c],
  ],
  /** 열화상 카메라 느낌 */
  inferno: [
    [0, 0x000004],
    [0.25, 0x57106e],
    [0.5, 0xbc3754],
    [0.75, 0xf98e09],
    [1, 0xfcffa4],
  ],
  /** 좋고 나쁨: 초록 → 노랑 → 빨강 */
  status: [
    [0, 0x1a9850],
    [0.5, 0xfee08b],
    [1, 0xd73027],
  ],
  /** 재실 밀도 */
  occupancy: [
    [0, 0x1b2440],
    [0.5, 0x6a51a3],
    [1, 0xf768a1],
  ],
} as const satisfies Record<string, Ramp>;

const a = new THREE.Color();
const b = new THREE.Color();

export function sampleRamp(ramp: Ramp, t: number, out = new THREE.Color()): THREE.Color {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  for (let i = 1; i < ramp.length; i++) {
    if (x <= ramp[i][0]) {
      const [p0, c0] = ramp[i - 1];
      const [p1, c1] = ramp[i];
      a.setHex(c0);
      b.setHex(c1);
      return out.copy(a).lerp(b, (x - p0) / (p1 - p0 || 1));
    }
  }
  return out.setHex(ramp[ramp.length - 1][1]);
}

/** 범례용 CSS 그라디언트 */
export function rampCss(ramp: Ramp): string {
  const stops = ramp.map(([p, c]) => `#${c.toString(16).padStart(6, '0')} ${p * 100}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
