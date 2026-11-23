/**
 * 실험용 가상 업무시설. 실제 PoC에서는 BMS 포인트 목록·도면에서 같은 구조를 만든다.
 * 좌표계: x = 동(+)·서(-), z = 남(+)·북(-), y = 위. 단위 m.
 */
export type ZoneType = 'office' | 'meeting' | 'lobby' | 'core';
export type Orientation = 'S' | 'N' | 'E' | 'W' | 'C';

export interface Zone {
  id: string;
  floor: number; // 0부터
  name: string;
  type: ZoneType;
  orient: Orientation;
  rect: { x0: number; x1: number; z0: number; z1: number };
  area: number;
  /** 센서 데이터 결측 구간(시뮬레이션 스텝). 데이터 신뢰성 시나리오용. */
  dataGap?: [number, number];
}

export const FLOOR_HEIGHT = 3.6;
export const FLOORS = 5;
export const FOOTPRINT = { w: 36, d: 24 };

const LAYOUT: Array<{ key: string; orient: Orientation; rect: Zone['rect'] }> = [
  { key: '남측', orient: 'S', rect: { x0: -18, x1: 18, z0: 7, z1: 12 } },
  { key: '북측', orient: 'N', rect: { x0: -18, x1: 18, z0: -12, z1: -7 } },
  { key: '동측', orient: 'E', rect: { x0: 13, x1: 18, z0: -7, z1: 7 } },
  { key: '서측', orient: 'W', rect: { x0: -18, x1: -13, z0: -7, z1: 7 } },
  { key: '중앙', orient: 'C', rect: { x0: -13, x1: 3, z0: -7, z1: 7 } },
  { key: '코어', orient: 'C', rect: { x0: 3, x1: 13, z0: -7, z1: 7 } },
];

function typeOf(floor: number, key: string): ZoneType {
  if (key === '코어') return 'core';
  if (floor === 0) return key === '남측' ? 'lobby' : 'office';
  if (key === '중앙') return 'meeting';
  return 'office';
}

const TYPE_NAME: Record<ZoneType, string> = { office: '사무', meeting: '회의', lobby: '로비', core: '코어·계단' };

export function createBuilding(): Zone[] {
  const zones: Zone[] = [];
  for (let f = 0; f < FLOORS; f++) {
    for (const l of LAYOUT) {
      const type = typeOf(f, l.key);
      const { x0, x1, z0, z1 } = l.rect;
      zones.push({
        id: `${f + 1}F-${l.orient}${l.key === '코어' ? 'K' : ''}`,
        floor: f,
        name: `${f + 1}층 ${l.key} ${TYPE_NAME[type]}`,
        type,
        orient: l.orient,
        rect: l.rect,
        area: (x1 - x0) * (z1 - z0),
      });
    }
  }
  // 센서 결측 시나리오: 3층 서측 11:00~13:30, 5층 남측 15:00~16:00
  const gap = (id: string, a: number, b: number) => {
    const z = zones.find((v) => v.id === id);
    if (z) z.dataGap = [a, b];
  };
  gap('3F-W', 132, 162);
  gap('5F-S', 180, 192);
  return zones;
}
