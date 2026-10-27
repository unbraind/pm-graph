/** Force write locks before ownership reads; rejected guards roll back every temporary property change. */
function ownershipPrelude(scope, all, incident) {
    const select = all ? `MATCH (n:${scope.label} {projectKey: $projectKey})` : `UNWIND $ids AS itemId MATCH (n:${scope.label} {projectKey: $projectKey, id: itemId})`;
    const relationships = incident ? `CALL { WITH ns UNWIND ns AS n MATCH (n)-[r]-() WITH DISTINCT r ORDER BY elementId(r)
SET r.__pmLock = NOT coalesce(r.__pmLock, false) REMOVE r.__pmLock RETURN collect(r) AS rs }` : "WITH ns, [] AS rs";
    return `${select}
WITH DISTINCT n ORDER BY n.id, elementId(n) SET n.__pmLock = NOT coalesce(n.__pmLock, false) REMOVE n.__pmLock
WITH collect(n) AS ns
${relationships}
WITH ns, rs, size([n IN ns WHERE n.pmGraphOwner IS NULL OR n.pmGraphOwner <> $owner])
 + size([r IN rs WHERE r.pmGraphOwner IS NULL OR r.pmGraphOwner <> $owner
 OR startNode(r).projectKey IS NULL OR startNode(r).projectKey <> $projectKey
 OR endNode(r).projectKey IS NULL OR endNode(r).projectKey <> $projectKey]) AS foreign`;
}
/** Check the exact touched scope while retaining all locks through its caller's transaction. */
export function ownedCheck(scope, ids) {
    return { statement: `${ownershipPrelude(scope, ids === null, false)} RETURN foreign`, parameters: { ...scope, ids: ids ?? [] }, expect: { key: "foreign", value: 0 } };
}
/** Delete only owned relationships, then plain DELETE refuses any concurrently attached foreign edge. */
export function ownedCleanup(scope, ids, currentIds, full) {
    const checked = scope.label === "PmGraphNode" ? `CALL {
MERGE (m:PmGraphSync {projectKey:$projectKey}) ON CREATE SET m.pmGraphOwner=$owner
SET m.__pmLock = NOT coalesce(m.__pmLock, false) REMOVE m.__pmLock
RETURN CASE WHEN m.pmGraphOwner=$owner THEN 0 ELSE 1 END AS markerForeign }
CALL { ${ownershipPrelude(scope, ids === null, true)} RETURN ns,rs,foreign }
WITH ns,rs,foreign + markerForeign AS foreign` : ownershipPrelude(scope, ids === null, true);
    return { statement: `${checked}
WITH ns, rs, foreign, [n IN ns WHERE $full OR (size($currentIds) > 0 AND NOT n.id IN $currentIds)] AS doomed
FOREACH (r IN CASE WHEN foreign = 0 THEN [r IN rs WHERE r.pmGraphOwner = $owner AND (startNode(r) IN doomed OR endNode(r) IN doomed)] ELSE [] END | DELETE r)
FOREACH (n IN CASE WHEN foreign = 0 THEN doomed ELSE [] END | DELETE n)
RETURN foreign, CASE WHEN foreign = 0 THEN size(doomed) ELSE 0 END AS deleted`,
        parameters: { ...scope, ids: ids ?? [], currentIds, full }, expect: { key: "foreign", value: 0 } };
}
/** Recheck a MERGE collision under its node lock before changing any native properties. */
export function ownedNode(scope, node, replace) {
    return { statement: `MERGE (n:${scope.label} {projectKey: $projectKey, id: $id}) ON CREATE SET n.pmGraphOwner = $owner
SET n.__pmLock = NOT coalesce(n.__pmLock, false) REMOVE n.__pmLock WITH n WHERE n.pmGraphOwner = $owner
SET n ${replace ? "=" : "+="} $properties, n.pmGraphOwner = $owner, n.projectKey = $projectKey, n.id = $id, n.labels = $labels RETURN count(n) AS written`,
        parameters: { ...scope, id: node.id, labels: node.labels, properties: node.properties }, expect: { key: "written", value: 1 } };
}
/** Lock endpoints and the merged relationship before rechecking ownership, including dense-node races. */
export function ownedEdge(scope, edge, replace) {
    return { statement: `MATCH (a:${scope.label} {projectKey: $projectKey, id: $from}), (b:${scope.label} {projectKey: $projectKey, id: $to})
FOREACH (n IN CASE WHEN a.id <= b.id THEN [a,b] ELSE [b,a] END | SET n.__pmLock = NOT coalesce(n.__pmLock, false) REMOVE n.__pmLock)
WITH a,b WHERE a.pmGraphOwner = $owner AND b.pmGraphOwner = $owner
MERGE (a)-[r:\`${edge.type}\`]->(b) ON CREATE SET r.pmGraphOwner = $owner
SET r.__pmLock = NOT coalesce(r.__pmLock, false) REMOVE r.__pmLock WITH r WHERE r.pmGraphOwner = $owner
SET r ${replace ? "=" : "+="} $properties, r.pmGraphOwner = $owner RETURN count(r) AS written`,
        parameters: { ...scope, from: edge.from, to: edge.to, properties: edge.properties }, expect: { key: "written", value: 1 } };
}
/** Revalidate explicit edge removals under relationship locks rather than relying on an earlier read. */
export function ownedEdgeRemoval(scope, edge) {
    return { statement: `MATCH (a:${scope.label} {projectKey: $projectKey, id: $from})-[r:\`${edge.type}\`]->(b:${scope.label} {projectKey: $projectKey, id: $to})
SET r.__pmLock = NOT coalesce(r.__pmLock, false) REMOVE r.__pmLock WITH collect(r) AS rs
WITH rs, size([r IN rs WHERE r.pmGraphOwner IS NULL OR r.pmGraphOwner <> $owner]) AS foreign
FOREACH (r IN CASE WHEN foreign = 0 THEN rs ELSE [] END | DELETE r) RETURN foreign`,
        parameters: { ...scope, from: edge.from, to: edge.to }, expect: { key: "foreign", value: 0 } };
}
//# sourceMappingURL=neo4j-ownership.js.map