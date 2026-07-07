/**
 * Query depth limit — a GraphQL validation rule rejecting overly nested
 * queries (Phase 13).
 *
 * Relationship traversal makes the reflected type graph cyclic
 * (Contacts → Companies → contacts_by_company → …), so an unbounded query
 * could walk it forever. The previous schema was flat and needed no cap;
 * now one validation rule measures each operation's selection depth —
 * resolving fragment spreads, ignoring introspection fields so GraphiQL's
 * schema query still works — and rejects anything past the limit before
 * execution starts.
 */

import {
  type ASTVisitor,
  type FragmentDefinitionNode,
  GraphQLError,
  Kind,
  type SelectionNode,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql';

/**
 * Selection levels allowed per operation. `{ contacts { data { company { name } } } }`
 * is 4 deep; the envelope (`data`/`pagination`) costs one level, so this
 * allows ~10 relation hops — far past any sane query, close enough to stop
 * a cycle walk instantly.
 */
export const MAX_QUERY_DEPTH = 12;

/** Deepest selection level reachable from a selection set. */
function measureSet(
  context: ValidationContext,
  set: SelectionSetNode,
  depth: number,
  seenFragments: ReadonlySet<string>,
): number {
  let max = depth;
  for (const selection of set.selections) {
    const child = measureSelection(context, selection, depth, seenFragments);
    if (child > max) max = child;
  }
  return max;
}

/** Depth contributed by one selection (field / inline fragment / spread). */
function measureSelection(
  context: ValidationContext,
  selection: SelectionNode,
  depth: number,
  seenFragments: ReadonlySet<string>,
): number {
  if (selection.kind === Kind.FIELD) {
    if (selection.name.value.startsWith('__')) return depth;
    return selection.selectionSet
      ? measureSet(context, selection.selectionSet, depth + 1, seenFragments)
      : depth;
  }
  if (selection.kind === Kind.INLINE_FRAGMENT) {
    return measureSet(context, selection.selectionSet, depth, seenFragments);
  }
  // Fragment spread — same depth, guard recursion.
  const name = selection.name.value;
  if (seenFragments.has(name)) return depth;
  const fragment: FragmentDefinitionNode | undefined | null = context.getFragment(name);
  if (!fragment) return depth;
  return measureSet(context, fragment.selectionSet, depth, new Set([...seenFragments, name]));
}

/** Builds the validation rule for {@link MAX_QUERY_DEPTH}-style caps. */
export function createDepthLimitRule(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition: {
      leave(node) {
        const depth = measureSet(context, node.selectionSet, 1, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query depth ${depth} exceeds the maximum allowed depth of ${maxDepth}`,
              { nodes: [node] },
            ),
          );
        }
      },
    },
  });
}
