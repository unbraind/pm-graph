/** Exercise branded output using real disposable tracker documents, never mocked SDK reads. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PmClient, listAllComplete, certifyCompleteListResult, type ItemMetadata } from '@unbrained/pm-cli/sdk';
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
