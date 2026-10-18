/** Exercise branded output using real disposable tracker documents, never mocked SDK reads. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { instance } from '@viz-js/viz';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PmClient, listAllComplete, certifyCompleteListResult, type ItemMetadata } from '@unbrained/pm-cli/sdk';
import { brandValues } from '../src/brand-values.ts';
import { renderAnalysisDiagram,renderPlantuml,graphFromItems,type Graph } from '../src/index.ts';

test('real tracker states retain labels, form strips, edges and deterministic Triplicate output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'triplicate-tracker-'));
  const pmRoot = join(root, '.agents', 'pm');
  const sdk = new PmClient({ cwd: root, pmRoot, author: 'fixture' });
  try {
    await sdk.init('visual', { defaults: true, mergeFence: false, agentGuidance: 'skip' });
    const states = ['open', 'in_progress', 'blocked', 'closed', 'canceled'] as const;
    for (const [index, status] of states.entries()) await sdk.create({ id: `visual-${status.replaceAll("_", "-")}`, title: `Review <${status}> & output`, type: 'Task', priority: index % 4, status, closeReason: 'Synthetic review fixture', dep: status === 'blocked' ? ['id=visual-in-progress,kind=blocked_by'] : [], estimatedMinutes: '480', createMode: 'progressive' });
    const result = certifyCompleteListResult(await listAllComplete({}, { pmRoot, noExtensions: true }));
    assert.equal(result.items.length, 5);
    const graph: Graph = graphFromItems(result.items as ItemMetadata[],'public fixture',new Map());

    graph.nodes.push({id:'facet',labels:['PmFacet'],properties:{title:'Facet without status'}});
    graph.nodes.push({id:'custom',labels:['PmItem'],properties:{title:'Custom',status:'draft',priority:'high'}});
    for(const theme of ['light','dark'] as const) {
      const mermaid=renderAnalysisDiagram('mermaid',graph,theme);
      const dot=renderAnalysisDiagram('dot',graph,theme);
      const uml=renderPlantuml(graph,theme);
      for(const output of [mermaid,dot,uml]) {
        assert.ok(output.includes('Martian Mono'));
        for(const status of states) assert.ok(output.includes(status));
        assert.ok(output.includes('BLOCKED_BY'));
        assert.doesNotMatch(output,/<img|https?:\/\/(?!www\.w3\.org)/u);
      }
      assert.equal(dot,renderAnalysisDiagram('dot',graph,theme));
      assert.match(mermaid,/pm-strip/u); assert.match(mermaid,/pm-status-blocked/u);
      assert.doesNotMatch(mermaid,/^\s*style .*var\(/mu);
      assert.match(dot,/<S>canceled<\/S>/u); assert.match(dot,/TABLE BORDER="1"/u);
      assert.match(uml,/<s>canceled<\/s>/u); assert.match(uml,/skinparam shadowing false/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('explicit Mermaid themes emit one palette even when the host prefers the opposite scheme', () => {
  const graph: Graph = { workspace: 'synthetic', projectKey: 'fixture', nodes: [], relationships: [], generatedAt: 'fixture' };
  for (const theme of ['light', 'dark'] as const) {
    const output = renderAnalysisDiagram('mermaid', graph, theme);
    const config = JSON.parse(output.slice('%%{init: '.length, output.indexOf('}%%'))) as { themeVariables: { darkMode: boolean }; themeCSS: string };
    assert.equal(config.themeVariables.darkMode, theme === 'dark');
    assert.match(config.themeCSS, new RegExp(`--pm-paper:${brandValues[theme].paper}`, 'u'));
    assert.ok(!config.themeCSS.includes(brandValues[theme === 'light' ? 'dark' : 'light'].paper));
    assert.doesNotMatch(config.themeCSS, /prefers-color-scheme|data-theme/u);
    assert.match(config.themeCSS, /prefers-reduced-motion/u);
  }
});

test('PlantUML custom status metacharacters stay inside a single literal cell', () => {
  const graph: Graph = { workspace: 'synthetic', projectKey: 'fixture', nodes: [{ id: 'custom', labels: ['PmItem'], properties: {
    title: 'Fixture', status: 'review|**bold**//italic//__under__--strike--~~wave~~[[link]]\\n<&>',
  } }], relationships: [], generatedAt: 'fixture' };
  for (const theme of ['light', 'dark'] as const) {
    const output = renderPlantuml(graph, theme);
    const line = output.split('\n').find(line => line.startsWith('object '))!;
    assert.equal(line.split('|').length - 1, 2, 'only generated table separators remain');
    assert.ok(line.includes('review<U+007C><U+002A><U+002A>bold'));
    assert.ok(line.includes('<U+002F><U+002F>italic'));
    assert.ok(line.includes('<U+005F><U+005F>under'));
    assert.ok(line.includes('<U+002D><U+002D>strike'));
    assert.ok(line.includes('<U+007E><U+007E>wave'));
    assert.ok(line.includes('<U+005B><U+005B>link<U+005D><U+005D><U+005C>n&lt;&amp;&gt;'));
  }
});


test('Graphviz HTML labels preserve literal substitutions, paths, XML text and title line breaks', async () => {
  const graph: Graph = { workspace: 'synthetic', projectKey: 'fixture', nodes: [{ id: 'task\\N', labels: ['Task'], properties: {
    title: 'line one\nline two \\N \\G C:\\work\\notes "quotes" & <text>',
    type: 'Task\\G\nsecond type', status: 'review\\N|C:\\work & "quoted"\nsecond status',
  } }], relationships: [], generatedAt: 'fixture' };
  const viz = await instance();
  for (const theme of ['light', 'dark'] as const) {
    const svg = viz.renderString(renderAnalysisDiagram('dot', graph, theme), { format: 'svg' });
    const texts = [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/gsu)].map(match => match[1]
      .replace(/&#(?:x([\da-f]+)|(\d+));/giu, (_entity, hex: string | undefined, decimal: string | undefined) => String.fromCodePoint(parseInt(hex ?? decimal!, hex ? 16 : 10)))
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
    assert.ok(texts.includes('line one'), JSON.stringify(texts));
    assert.ok(texts.includes('line two \\N \\G C:\\work\\notes "quotes" & <text>'), JSON.stringify(texts));
    assert.ok(texts.includes('task\\N · Task\\G'), JSON.stringify(texts));
    assert.ok(texts.includes('second type'), JSON.stringify(texts));
    assert.ok(texts.includes('review\\N|C:\\work & "quoted"'), JSON.stringify(texts));
    assert.ok(texts.includes('second status'), JSON.stringify(texts));
  }
});
