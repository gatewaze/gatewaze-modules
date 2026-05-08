/**
 * User-saved block — a stash of an arbitrary subtree the operator
 * named and saved from the canvas. Can be re-inserted into any of the
 * newsletter's editions.
 *
 * `tree` is the same shape `puckDataToEdition` produces: a single
 * registry entry with `props` (and recursive `props.children` for
 * slot containers). At insert time the tree's outer becomes a fresh
 * top-level block in the edition; nested children flow through the
 * normal `block.content.children` JSON path.
 */
export interface UserBlock {
  id: string;
  label: string;
  description: string;
  /** ISO timestamp. */
  created_at: string;
  /**
   * The saved tree — a single entry whose `type` is a registry
   * componentId and `props` carries the saved field values. For slot
   * containers, `props.children` is the recursive subtree.
   */
  tree: {
    type: string;
    props: Record<string, unknown>;
  };
}
