# Changelog

## 2026.7.10-1 - 2026-07-10

### Added

- Full pm ecosystem production pass for pm-graph ([pm-graph-dhzp](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/features/pm-graph-dhzp.toon))
- Hands-on functional test pass 2026-05-29 (real data) ([pm-graph-n0nt](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/features/pm-graph-n0nt.toon))

### Fixed

- Fix node filter dedup and application, update version constant ([pm-graph-4mil](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-4mil.toon))
- Adversarial review pass 2026-07-10 ([pm-graph-3mny](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/chores/pm-graph-3mny.toon))

### Other

- Production-readiness audit 2026-05-29 ([pm-graph-fq9w](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-fq9w.toon))
- Full-cycle hardening wave: pm-graph ([pm-graph-4yd1](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-4yd1.toon))
- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-graph-avy6](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/chores/pm-graph-avy6.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-graph-cb1l](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-cb1l.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-graph-yrkr](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-yrkr.toon))
- Regenerate CHANGELOG after pm close item ([pm-graph-ozh8](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-ozh8.toon))

## 2026.6.9-1 - 2026-06-09

### Added

- Add --format mermaid/graphml to graph cycles and critical-path ([pm-graph-jqiv](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/features/pm-graph-jqiv.toon))

## 2026.6.7 - 2026-06-07

### Added

- Report bottleneck connectors in graph analytics ([pm-graph-zod7](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/features/pm-graph-zod7.toon))

### Other

- Harden release readiness checks ([pm-graph-uj77](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/chores/pm-graph-uj77.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-graph-bnsw](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/chores/pm-graph-bnsw.toon))

## 2026.6.4 - 2026-06-04

### Added

- Add topo-sort, impact, and dependency-depth analytics ([pm-graph-r5yz](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/features/pm-graph-r5yz.toon))

## 2026.6.2-1 - 2026-06-02

### Added

- Deepen pm-graph with offline analytics + new export formats ([pm-graph-1dpk](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/features/pm-graph-1dpk.toon))
- Unit tests for analytics + new renderers ([pm-graph-f9c3](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-f9c3.toon))
- graph exporter: add graphml + plantuml formats ([pm-graph-79f2](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-79f2.toon))

### Other

- pm-graph critical-path: longest blocking chain ([pm-graph-f1k9](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-f1k9.toon))
- pm-graph path: shortest dependency path (BFS) ([pm-graph-vtlu](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-vtlu.toon))
- pm-graph cycles: detect dependency cycles, CI exit code ([pm-graph-h0xs](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-h0xs.toon))
- pm-graph analyze: offline graph-health report ([pm-graph-d9tz](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-d9tz.toon))
- Decision: analytics operate on STRUCTURAL edges only ([pm-graph-89nw](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-89nw.toon))

## 2026.6.2 - 2026-06-02

### Added

- Add multi-format graph exporter (pm graph export): cypher, mermaid, dot, json-graph ([pm-graph-xii9](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/features/pm-graph-xii9.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-graph-e0at](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-e0at.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-graph-41bm](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-41bm.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-graph-e063](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-e063.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-graph-f03m](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-f03m.toon))

### Other

- Release readiness hardening for pm-graph ([pm-graph-fnu1](https://github.com/unbraind/pm-graph/blob/main/.agents/pm/tasks/pm-graph-fnu1.toon))
