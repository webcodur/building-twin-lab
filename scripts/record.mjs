// 실험별 동작 장면을 녹화해 media/promo/assets/clips/*.webm 으로 저장한다(소개 영상 재료).
// 사용: pnpm dev 로 서버를 띄운 뒤 node scripts/record.mjs
import { chromium } from 'playwright';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:5180/';
const OUT = fileURLToPath(new URL('../media/promo/assets/clips/', import.meta.url));
const TMP = fileURLToPath(new URL('../media/promo/assets/clips/_raw/', import.meta.url));
mkdirSync(TMP, { recursive: true });

const SIZE = { width: 1600, height: 900 };
const btn = (p, name) => p.locator('button', { hasText: new RegExp(`^${name}$`) }).first().click();
const drag = async (p, x0, y0, x1, y1) => {
  await p.mouse.move(x0, y0);
  await p.mouse.down();
  await p.mouse.move(x1, y1, { steps: 14 });
  await p.mouse.up();
};
/** 슬라이더를 a→b로 부드럽게 민다. */
const sweep = async (p, label, a, b, ms, steps = 40) => {
  const input = p.getByLabel(label);
  for (let i = 0; i <= steps; i++) {
    await input.fill(String(a + ((b - a) * i) / steps));
    await p.waitForTimeout(ms / steps);
  }
};

const SCENES = {
  twin: async (p) => {
    await p.waitForTimeout(1200);
    await btn(p, '전력');
    await sweep(p, '층 분리', 0, 1.1, 1400);
    await p.waitForTimeout(1600);
  },
  scan: async (p) => {
    await p.waitForTimeout(2600);
    await btn(p, '벽 추출 실행');
    await btn(p, '분류');
    await p.waitForTimeout(1800);
  },
  plan: async (p) => {
    await p.waitForTimeout(600);
    await btn(p, '전부 지우기');
    await drag(p, 330, 260, 640, 520);
    await drag(p, 640, 260, 900, 520);
    await drag(p, 330, 520, 900, 640);
    await btn(p, '3D 보기');
    await p.waitForTimeout(2600);
  },
  envelope: async (p) => {
    await btn(p, '순간 일사');
    await sweep(p, '태양시', 7, 18, 3200, 60);
    await btn(p, '열손실');
    await p.waitForTimeout(700);
    await btn(p, '리노베이션 후');
    await p.waitForTimeout(1200);
  },
  portfolio: async (p) => {
    await btn(p, '실시간 부하');
    await p.waitForTimeout(1400);
    await p.mouse.move(700, 560);
    await p.waitForTimeout(300);
    await p.mouse.click(700, 560);
    await p.waitForTimeout(2600);
  },
};

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ONLY = process.argv.slice(3);
for (const [id, run] of Object.entries(SCENES)) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: TMP, size: SIZE } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}#/${id}`);
  await page.locator('.panel').waitFor();
  await run(page);
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), `${OUT}${id}.webm`);
  console.log(`녹화: ${id}.webm`);
}
await browser.close();
rmSync(TMP, { recursive: true, force: true });
