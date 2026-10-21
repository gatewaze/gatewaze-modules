/**
 * Approval view route (newsletters/approve/:id). Renders the edition editor
 * in approval mode: a full-screen, cut-down editor for an approver.
 */
import EditionEditorPage from '../editions/[id]';

export default function EditionApprovalPage() {
  return <EditionEditorPage approvalMode />;
}
