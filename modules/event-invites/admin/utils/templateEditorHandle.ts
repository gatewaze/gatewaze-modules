/**
 * Imperative handle exposed by template editors so that a parent (the
 * template manager) can own the modal footer and trigger save from there.
 */
export interface TemplateEditorHandle {
  /**
   * Runs validation + persists the template. Rejects on validation failure
   * or server error; resolves once the save is complete.
   */
  save: () => Promise<void>;
}
