import type { GraphNode, GraphRelationship } from "./index.ts";
/** Fixed package namespaces; user data never supplies a Cypher label. */
export type OwnedScope = {
    label: "PmGraphNode" | "PmGraphProjectionNode";
    projectKey: string;
    owner: string;
};
/** A producer and executor share the same query and required result predicate. */
export type OwnedStatement = {
    statement: string;
    parameters: Record<string, unknown>;
    expect: {
        key: "foreign" | "written";
        value: number;
    };
};
/** Check the exact touched scope while retaining all locks through its caller's transaction. */
export declare function ownedCheck(scope: OwnedScope, ids: string[] | null): OwnedStatement;
/** Delete only owned relationships, then plain DELETE refuses any concurrently attached foreign edge. */
export declare function ownedCleanup(scope: OwnedScope, ids: string[] | null, currentIds: string[], full: boolean): OwnedStatement;
/** Recheck a MERGE collision under its node lock before changing any native properties. */
export declare function ownedNode(scope: OwnedScope, node: GraphNode, replace: boolean): OwnedStatement;
/** Lock endpoints and the merged relationship before rechecking ownership, including dense-node races. */
export declare function ownedEdge(scope: OwnedScope, edge: GraphRelationship, replace: boolean): OwnedStatement;
/** Revalidate explicit edge removals under relationship locks rather than relying on an earlier read. */
export declare function ownedEdgeRemoval(scope: OwnedScope, edge: GraphRelationship): OwnedStatement;
