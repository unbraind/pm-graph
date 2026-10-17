/** Prove each visual renderer regression independently while keeping the package worktree untouched. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const baseline = process.argv[2] ?? 'origin/main';
const sourcePath = 'src/index.ts';
const current = readFileSync(join(root, sourcePath), 'utf8');
const previous = execFileSync('git', ['show', `${baseline}:${sourcePath}`], { cwd:root,encoding:'utf8' });
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
  const target=join(scratch,sourcePath);
  const renderers: Array<readonly [string,string]> = [
    ['function renderMermaid(', '\n/** Escape a string for a Graphviz'],
    ['function renderDot(', '\n/** A JSON Graph'],
    ['export function renderPlantuml(', '\n/**\n * Render a graph in the requested'],
  ];
  for(const [start,boundary] of renderers) {
    const before=implementation(previous,start,boundary);
    const after=implementation(current,start,boundary);
    writeFileSync(target,current.slice(0,after.start)+before.body+current.slice(after.end));
    const result=spawnSync(process.execPath,['--test','test/triplicate-visuals.test.ts'],{cwd:scratch,encoding:'utf8'});
    assert.equal(result.status,1,`${start}: reverting only this renderer must fail its unchanged regression test\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout,/fail 1/u);
    console.log(`${start}: behavioral revert failed 1/1 as required`);
  }
  writeFileSync(target,current);
  const restored=spawnSync(process.execPath,['--test','test/triplicate-visuals.test.ts'],{cwd:scratch,encoding:'utf8'});
  assert.equal(restored.status,0,restored.stdout+restored.stderr);
  assert.match(restored.stdout,/pass 1/u);
  console.log('Restored Triplicate renderers passed 1/1');
} finally { rmSync(scratch,{recursive:true,force:true}); }
