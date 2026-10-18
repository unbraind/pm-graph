/** Prove each visual renderer regression independently while keeping the package worktree untouched. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const review = process.argv[2] === '--review';
const baseline = review ? '9922ad9404b9420d84c8f3d02bba0af50ec1dbf8' : process.argv[2] ?? 'origin/main';
const scratch = mkdtempSync(join(tmpdir(), 'triplicate-revert-'));

/** Return just the renderer implementation, stopping at the following stable section boundary. */
function implementation(source: string, start: string, boundary: string): { start:number; end:number; body:string } {
  const from=source.indexOf(start);
  const end=source.indexOf(boundary,from);
  assert.ok(from>=0&&end>from,'Renderer and following boundary must exist');
  return {start:from,end,body:source.slice(from,end)};
}

try {
  cpSync(join(root,'package.json'),join(scratch,'package.json'));
  cpSync(join(root,'src'),join(scratch,'src'),{recursive:true});
  mkdirSync(join(scratch,'test'),{recursive:true});
  cpSync(join(root,'test/triplicate-visuals.test.ts'),join(scratch,'test/triplicate-visuals.test.ts'));
  symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
  const cases: Array<readonly [string, string, string, string]> = review ? [
    ['src/brand.ts', 'export function mermaidBrand(', '/** Composite', 'explicit Mermaid themes'],
    ['src/index.ts', 'export function renderPlantuml(', '/**\n * Render a graph in the requested', 'PlantUML custom status'],
    ['src/index.ts', 'function renderDot(', '/** A JSON Graph', 'Graphviz HTML labels'],
  ] : [
    ['src/index.ts', 'function renderMermaid(', '/** Escape a string for a Graphviz', 'real tracker states'],
    ['src/index.ts', 'function renderDot(', '/** A JSON Graph', 'real tracker states'],
    ['src/index.ts', 'export function renderPlantuml(', '/**\n * Render a graph in the requested', 'real tracker states'],
  ];
  for (const [sourcePath, start, boundary, pattern] of cases) {
    const current = readFileSync(join(root, sourcePath), 'utf8');
    const previous = execFileSync('git', ['show', `${baseline}:${sourcePath}`], { cwd: root, encoding: 'utf8' });
    const before = implementation(previous, start, boundary);
    const after = implementation(current, start, boundary);
    const target = join(scratch, sourcePath);
    writeFileSync(target, current.slice(0, after.start) + before.body + current.slice(after.end));
    const args = ['--test', `--test-name-pattern=${pattern}`, 'test/triplicate-visuals.test.ts'];
    const reverted = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8' });
    assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
    assert.match(reverted.stdout, /AssertionError/u);
    assert.match(reverted.stdout, /fail 1/u);
    writeFileSync(target, current);
    const restored = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /pass 1/u);
    console.log(`${pattern}: function-only revert fails 1/1; restored passes 1/1`);
  }
} finally { rmSync(scratch,{recursive:true,force:true}); }
