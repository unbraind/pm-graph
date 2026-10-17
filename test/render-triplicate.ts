/** Reproduce review diagrams from the captured public brand-kit tracker, without hosted data. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderAnalysisDiagram, renderPlantuml, graphFromItems, type Graph } from '../src/index.ts';
import type { ItemMetadata } from '@unbrained/pm-cli/sdk';
/** Public fields retained from the fixture tracker. */
interface ReviewItem { id:string; title:string; type:string; status:string; priority:number; parent?:string }
const output = resolve(process.argv[2]);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/triplicate.json', import.meta.url), 'utf8')) as { items: ReviewItem[] };
const full = graphFromItems(fixture.items as ItemMetadata[], 'public brand kit tracker', new Map());
const ids = new Set(fixture.items.map(item => item.id));
const graph: Graph = { ...full, generatedAt:'2026-10-17T00:00:00.000Z', nodes:full.nodes.filter(node=>ids.has(node.id)), relationships:full.relationships.filter(edge=>ids.has(edge.from)&&ids.has(edge.to)) };

mkdirSync(output,{recursive:true});
for (const theme of ['light','dark'] as const) {
  const suffix = theme === 'light' ? '' : '-dark';
  writeFileSync(resolve(output,`graph${suffix}.mmd`),renderAnalysisDiagram('mermaid',graph,theme));
  writeFileSync(resolve(output,`graph${suffix}.dot`),renderAnalysisDiagram('dot',graph,theme));
  writeFileSync(resolve(output,`graph${suffix}.puml`),renderPlantuml(graph,theme));
}
console.log('Six deterministic graph review diagrams generated');
