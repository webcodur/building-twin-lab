// 실험 화면을 캡처해 media/screens/에 저장하고 콘솔 오류를 보고한다.
// 사용: pnpm dev 로 서버를 띄운 뒤 pnpm capture [기준 URL]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:5180/';
const OUT = fileURLToPath(new URL('../media/screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const click = (text) => async (p) => p.getByRole('button', { name: text, exact: true }).first().click();
const wait = (ms) => async (p) => p.waitForTimeout(ms);
const drag = (x0, y0, x1, y1) => async (p) => {
  await p.mouse.move(x0, y0);
  await p.mouse.down();
  await p.mouse.move(x1, y1, { steps: 8 });
  await p.mouse.up();
};

/** [파일 이름, 해시, 조작들] */
const SHOTS = [
  ['twin-explode', 'twin', [async (p) => p.getByLabel('층 분리').fill('1.2'), click('전력'), wait(2000)]],
  ['twin-select', 'twin', [click('재실'), wait(600), async (p) => p.mouse.click(640, 520), wait(1500)]],
  ['scan', 'scan', [wait(3200)]],
  ['scan-recon', 'scan', [wait(2800), click('벽 추출 실행'), click('분류'), wait(800)]],
  ['plan-drawn', 'plan', [wait(1500), click('전부 지우기'), drag(300, 260, 640, 520), drag(640, 260, 900, 520), drag(300, 520, 900, 640), wait(500)]],
  ['plan-3d', 'plan', [click('3D 보기'), wait(2200)]],
  ['envelope-solar', 'envelope', [wait(1500)]],
  ['envelope-heatloss', 'envelope', [click('열손실'), wait(1200)]],
  ['portfolio-live', 'portfolio', [click('실시간 부하'), wait(1500)]],
  ['portfolio-select', 'portfolio', [wait(1200), async (p) => { await p.mouse.move(640, 600); await p.waitForTimeout(300); await p.mouse.click(640, 600); }, wait(1800)]],
];

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(`[${page.url()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push(`[${page.url()}] ${e.message}`));

for (const [name, hash, steps] of SHOTS) {
  await page.goto(`${BASE}#/${hash}`);
  await page.reload(); // 해시만 바꾸면 이전 실험 상태가 남을 수 있어 새로 읽는다.
  for (const s of steps) await s(page);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`캡처: ${name}.png`);
}
await browser.close();
if (errors.length) {
  console.log(`\n콘솔 오류 ${errors.length}건`);
  errors.forEach((e) => console.log(e));
  process.exitCode = 1;
} else console.log('\n콘솔 오류 없음');
