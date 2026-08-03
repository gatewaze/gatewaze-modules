// @ts-nocheck
/**
 * <ProjectAvatar> — renders a project's mark (issue #27, outline-icon pass).
 *
 * Honours a user-set `avatar_emoji`; falls back to a monochrome outline `FolderIcon` so the default
 * matches the rest of the admin app instead of an OS-coloured `📁` emoji. Decorative next to the
 * project name → `aria-hidden`. The branch logic lives in ./projectAvatar (pure, unit-tested).
 */
import React from 'react';
import { FolderIcon } from '@heroicons/react/24/outline';
import { resolveProjectAvatar } from './projectAvatar';

export function ProjectAvatar({
  emoji,
  className = 'size-4',
}: {
  emoji?: string | null;
  className?: string;
}) {
  const resolved = resolveProjectAvatar(emoji);
  return resolved.kind === 'emoji' ? (
    <span aria-hidden>{resolved.value}</span>
  ) : (
    <FolderIcon className={className} aria-hidden />
  );
}

export default ProjectAvatar;
