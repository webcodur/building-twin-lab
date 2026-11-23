import type { Zone, ZoneType } from '../data/building';
import { FLOORS } from '../data/building';

/**
 * 존 단위 1R1C 열 모델로 하루(여름 평일)를 시뮬레이션한다.
 * 목적은 정확한 에너지 해석이 아니라, 3D 화면에 "고정 스케줄 대비 AI 제어"의 차이를
 * 그럴듯한 시계열로 보여 주는 것이다. 실제 PoC에서는 이 자리에 BMS 실측·예측 API가 들어간다.
 */
export const STEP_MIN = 5;
export const STEPS = (24 * 60) / STEP_MIN; // 288
const DT = STEP_MIN * 60; // s
const RECOVERY = 1800; // s, 설정온도 복귀 시정수
const OA_RATE = 0.0012; // ㎥/s·㎡ 외기 도입량
const LATENT = 2.2; // 여름철 잠열 포함 배수
const FAN = 3.5; // W/㎡ 정풍량 팬 전력

export const COMFORT = { min: 23.0, max: 26.0 };

export type Scenario = 'baseline' | 'ai';

export interface ScenarioResult {
  temp: Float32Array[]; // 존별 실내온도 ℃
  power: Float32Array[]; // 존별 전력 W (냉방 전기 + 팬)
  totalPower: Float32Array; // 건물 전체 kW
  cumEnergy: Float32Array; // 누적 kWh
  energy: number; // 하루 kWh
  comfort: number; // 재실 시간 중 쾌적 범위 비율 0..1
}

export interface SimResult {
  occ: Float32Array[]; // 존별 재실률 0..1
  outdoor: Float32Array; // 외기온도
  baseline: ScenarioResult;
  ai: ScenarioResult;
}

export const hourOf = (step: number) => (step * STEP_MIN) / 60;

export function outdoorTemp(h: number): number {
  // 새벽 4시 최저 25℃, 오후 3시 최고 34℃ 근처
  return 29.5 + 4.5 * Math.sin(((h - 9) / 24) * Math.PI * 2);
}

function bump(h: number, center: number, width: number): number {
  const x = (h - center) / width;
  return Math.max(0, 1 - x * x);
}

/** 존 유형별 재실 프로파일. seed로 존마다 약간 다르게 만든다. */
function occupancy(type: ZoneType, h: number, seed: number): number {
  const jitter = 0.85 + 0.15 * Math.sin(seed * 12.9898 + h * 0.7);
  switch (type) {
    case 'office': {
      if (h < 7.5 || h > 21) return 0;
      const arrive = Math.min(1, Math.max(0, (h - 7.5) / 1.5));
      const leave = Math.min(1, Math.max(0, (20 - h) / 2));
      const lunch = 1 - 0.45 * bump(h, 12.5, 0.7);
      return Math.min(arrive, leave) * lunch * 0.9 * jitter;
    }
    case 'meeting': {
      // 오전·오후 회의 블록. 회의실은 하루 대부분 비어 있다.
      const m = Math.max(bump(h, 10.5, 0.8), bump(h, 14.5 + (seed % 2), 0.9), 0.4 * bump(h, 16.8, 0.5));
      return m * 0.95 * jitter;
    }
    case 'lobby':
      return Math.min(1, 0.15 * (h > 7 && h < 20 ? 1 : 0) + bump(h, 8.6, 0.8) + 0.6 * bump(h, 12.3, 0.8) + 0.7 * bump(h, 18.4, 0.8));
    case 'core':
      return h > 7 && h < 20 ? 0.05 : 0;
  }
}

const PEOPLE_DENSITY: Record<ZoneType, number> = { office: 0.1, meeting: 0.4, lobby: 0.15, core: 0.02 }; // 인/m²

function solarGain(z: Zone, h: number): number {
  // 바닥면적당 W. 방위별로 해가 드는 시각이 다르다.
  const peak = { S: 12.5, E: 9, W: 16, N: 13, C: 13 }[z.orient];
  const amp = { S: 38, E: 42, W: 48, N: 10, C: 0 }[z.orient];
  const s = Math.max(0, Math.cos(((h - peak) / 5) * (Math.PI / 2)));
  const roof = z.floor === FLOORS - 1 ? 14 * Math.max(0, Math.sin(((h - 6) / 13) * Math.PI)) : 0;
  return (amp * s + roof) * z.area;
}

function cop(To: number): number {
  // 외기가 시원할수록 냉동기 효율이 높다 → 아침 예냉의 근거
  return 4.6 - 0.09 * (To - 25);
}

interface Policy {
  (z: Zone, step: number, occ: Float32Array, To: number): number | null; // 설정온도 또는 정지(null)
}

/** 관행: 07~20시 전 존 24℃ 고정 */
const baselinePolicy: Policy = (_z, step) => {
  const h = hourOf(step);
  return h >= 7 && h < 20 ? 24 : null;
};

/** AI 제어 흉내: 재실 예측 기반 기동·정지, 비재실 셋백, 쾌적 범위 상단 활용, 아침 예냉 */
const aiPolicy: Policy = (z, step, occ) => {
  const h = hourOf(step);
  const look = Math.min(STEPS - 1, step + 12); // 1시간 뒤 재실 예측
  const nowOcc = occ[step];
  const soonOcc = occ[look];
  if (z.type === 'core') return h >= 8 && h < 19 ? 26.5 : null;
  if (h >= 6 && h < 8 && soonOcc > 0.2) return 23.5; // 외기가 시원할 때 미리 식혀 둔다
  if (nowOcc > 0.15) return h >= 13.5 && h < 16.5 ? 25.8 : 25.2; // 피크 시간대 쾌적 상한 쪽으로
  if (soonOcc > 0.15) return 26; // 곧 사람이 온다
  if (h >= 8 && h < 19) return 26.5; // 낮 비재실 셋백
  return null;
};

/**
 * smart = AI 운전 측 부가 기능
 * - 재실 기반 외기 도입량 제어(DCV): 사람이 없으면 외기를 덜 들여 외기 부하를 줄인다.
 * - 팬 변속: 팬 전력은 풍량의 세제곱에 비례하므로 부분 부하에서 크게 준다.
 */
function run(zones: Zone[], occ: Float32Array[], outdoor: Float32Array, policy: Policy, smart: boolean): ScenarioResult {
  const temp: Float32Array[] = [];
  const power: Float32Array[] = [];
  const totalPower = new Float32Array(STEPS);
  let occSteps = 0;
  let okSteps = 0;

  zones.forEach((z, i) => {
    const UA = (z.orient === 'C' ? 0.35 : 1.6) * z.area + (z.floor === FLOORS - 1 ? 0.5 * z.area : 0); // W/K
    const C = 55_000 * z.area; // J/K
    const qMax = 95 * z.area; // 냉방 용량 W
    const T = new Float32Array(STEPS);
    const P = new Float32Array(STEPS);
    let t = 27.5; // 자정 실내온도
    for (let s = 0; s < STEPS; s++) {
      const h = hourOf(s);
      const To = outdoor[s];
      const o = occ[i][s];
      const gains = solarGain(z, h) + o * z.area * (PEOPLE_DENSITY[z.type] * 110 + 12) + (o > 0.05 ? 7 * z.area : 0);
      const sp = policy(z, s, occ[i], To);
      // 설정온도에 맞추는 데 필요한 열량(이상 제어기)을 용량으로 자른다.
      let q = 0;
      if (sp !== null) {
        // 설정온도로 30분에 걸쳐 복귀하는 데 필요한 열량을 용량으로 자른다.
        const need = ((t - sp) * C) / RECOVERY + gains + UA * (To - t);
        q = Math.min(qMax, Math.max(0, need));
      }
      t += ((gains + UA * (To - t) - q) * DT) / C;
      T[s] = t;
      if (sp !== null) {
        const oaRate = OA_RATE * (smart ? 0.4 + 0.6 * Math.min(1, o / 0.6) : 1); // ㎥/s·㎡
        const oaLoad = oaRate * z.area * 1.2 * 1006 * Math.max(0, To - t) * LATENT;
        const fan = FAN * z.area * (smart ? Math.max(0.45, Math.pow(0.55 + 0.45 * (q / qMax), 3)) : 1);
        P[s] = (q + oaLoad) / cop(To) + fan;
      }
      totalPower[s] += P[s] / 1000;
      if (o > 0.2) {
        occSteps++;
        if (t >= COMFORT.min && t <= COMFORT.max) okSteps++;
      }
    }
    temp.push(T);
    power.push(P);
  });

  const cumEnergy = new Float32Array(STEPS);
  let acc = 0;
  for (let s = 0; s < STEPS; s++) {
    acc += (totalPower[s] * DT) / 3600;
    cumEnergy[s] = acc;
  }
  return { temp, power, totalPower, cumEnergy, energy: acc, comfort: occSteps ? okSteps / occSteps : 1 };
}

export function simulate(zones: Zone[]): SimResult {
  const outdoor = new Float32Array(STEPS).map((_, s) => outdoorTemp(hourOf(s)));
  const occ = zones.map((z, i) => new Float32Array(STEPS).map((_, s) => occupancy(z.type, hourOf(s), i)));
  return {
    occ,
    outdoor,
    baseline: run(zones, occ, outdoor, baselinePolicy, false),
    ai: run(zones, occ, outdoor, aiPolicy, true),
  };
}

export const fmtTime = (step: number) => {
  const m = step * STEP_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
