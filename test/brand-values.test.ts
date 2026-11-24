/** Verify baked values against the exact brand dependency and measure every rendered text pairing. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokens } from 'pm-brand';
import { contrast } from 'pm-brand/contrast';
import { brandValues } from '../src/brand-values.ts';
import { brandCss, brandStatus, brandStatuses, brandValue, mermaidBrand , brandColor } from '../src/brand.ts';
import { brandValuesSource, generateBrandValues, main } from '../scripts/brand-values.ts';

test('generated runtime values equal the pinned pm-brand typed tokens in both themes', () => {
  assert.deepEqual(brandValues, tokens);
  assert.equal(readFileSync('src/brand-values.ts', 'utf8'), brandValuesSource());
  for (const theme of ['light', 'dark'] as const) for (const name of Object.keys(tokens[theme]) as Array<keyof typeof tokens.light>) {
    assert.equal(typeof brandValue(theme, name), 'string');
  }
  assert.equal(brandStatus('draft'), 'open');
  assert.equal(brandStatus('custom-status'), 'open');
  for (const state of brandStatuses) assert.equal(brandStatus(state), state);
  assert.match(brandCss, /prefers-color-scheme:dark/u);
  assert.match(brandCss, /data-theme="dark"/u);
  for (const theme of ['light', 'dark'] as const) assert.ok(mermaidBrand(brandCss, theme).includes(tokens[theme].paper));
  assert.ok(mermaidBrand('static').includes(tokens.light.paper));
  assert.equal(brandColor('light', 'sheet'), tokens.light.sheet);
  assert.equal(brandColor('dark', 'status-canceled-bg'), tokens.dark.sheet);
  assert.match(brandColor('light', 'rule'), /^#[a-f0-9]{6}$/u);
  assert.match(brandColor('dark', 'status-canceled-border'), /^#[a-f0-9]{6}$/u);
});

test('the build gate fails on a changed baked value and regenerates deterministically in a real directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'triplicate-values-'));
  try {
    mkdirSync(join(root, 'src'));
    generateBrandValues(root, false);
    const target = join(root, 'src/brand-values.ts');
    const original = readFileSync(target, 'utf8');
    assert.equal(original, brandValuesSource());
    generateBrandValues(root, true);
    writeFileSync(target, original.replace('#F3F5F8', '#000000'));
    assert.throws(() => generateBrandValues(root, true), /Stale brand values/u);
    main([root]); main([root, '--check']);
    assert.equal(readFileSync(target, 'utf8'), original);
    main([]); main(['--check']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all actual text and status backgrounds meet WCAG AA in both themes; focus meets 3:1', () => {
  let measured = 0;
  for (const theme of ['light', 'dark'] as const) {
    for (const [foreground, background] of [
      ['carbon', 'paper'], ['carbon', 'sheet'], ['graphite', 'paper'], ['graphite', 'sheet'],
      ['stamp', 'paper'], ['stamp', 'sheet'], ['carbon', 'stamp-wash'],
    ] as const) {
      assert.ok(contrast(brandValue(theme, foreground), brandValue(theme, background)) >= 4.5, `${theme} ${foreground}/${background}`);
      measured++;
    }
    for (const state of brandStatuses) {
      const fg = brandValue(theme, `status-${state}-fg`);
      const bg = state === 'canceled' ? brandValue(theme, 'sheet') : brandValue(theme, `status-${state}-bg`);
      assert.ok(contrast(fg, bg) >= 4.5, `${theme} ${state}`); measured++;
    }
    assert.ok(contrast(brandValue(theme, 'stamp'), brandValue(theme, 'paper')) >= 3);
    assert.ok(contrast(brandValue(theme, 'stamp'), brandValue(theme, 'sheet')) >= 3);
  }
  assert.equal(measured, 24);
});


test('the published brand kit is integrity-locked at an exact build-time version', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string,string>; dependencies?: Record<string,string> };
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    packages: Record<string, { version: string; resolved: string; integrity: string; dev?: boolean }>;
  };
  const version = manifest.devDependencies['pm-brand'];
  assert.match(version, /^\d{4}\.\d{1,2}\.\d{1,2}$/u);
  const brand = lock.packages['node_modules/pm-brand'];
  assert.equal(brand.version, version);
  assert.equal(brand.resolved, `https://registry.npmjs.org/pm-brand/-/pm-brand-${version}.tgz`);
  assert.match(brand.integrity, /^sha512-[A-Za-z0-9+/]+=*$/u);
  assert.equal(brand.dev, true);
  assert.equal(manifest.dependencies?.['pm-brand'], undefined);
  for (const spec of Object.values(manifest.dependencies ?? {})) assert.ok(!spec.startsWith('github:'));
  const runtime = readFileSync('src/brand.ts', 'utf8') + readFileSync('src/brand-values.ts', 'utf8');
  assert.doesNotMatch(runtime, /from ['"]pm-brand/u);
});
