// 시뮬레이션 지표를 콘솔로 확인한다: npx tsx scripts/sim-check.mts
import { createBuilding } from '../src/data/building';
import { simulate, fmtTime, STEPS } from '../src/sim/thermal';
const z = createBuilding();
const r = simulate(z);
const peak = (a: Float32Array) => Math.max(...a);
console.log('일 전력량 kWh', r.baseline.energy.toFixed(0), '→', r.ai.energy.toFixed(0), `절감 ${((1 - r.ai.energy / r.baseline.energy) * 100).toFixed(1)}%`);
console.log('피크 kW', peak(r.baseline.totalPower).toFixed(0), '→', peak(r.ai.totalPower).toFixed(0));
console.log('쾌적', (r.baseline.comfort * 100).toFixed(1), '→', (r.ai.comfort * 100).toFixed(1));
for (let s = 0; s < STEPS; s += 24) console.log(fmtTime(s), r.baseline.totalPower[s].toFixed(0).padStart(4), r.ai.totalPower[s].toFixed(0).padStart(4), '| 3F남', r.baseline.temp[12][s].toFixed(1), r.ai.temp[12][s].toFixed(1));
