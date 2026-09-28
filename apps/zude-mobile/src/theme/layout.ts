import { theme as t } from "./tokens";

// One responsive policy for the shell, timelines, inspectors and composer.
// Text scaling deliberately opts into the more forgiving stacked composition.
export function workspaceLayout(width: number, height: number, fontScale = 1) {
  const persistent = width >= t.layout.sidebarBreakpoint && fontScale < 1.5;
  const workspaceWidth = Math.max(0, width - (persistent ? t.layout.sidebar : 0));
  return {
    persistent,
    split: workspaceWidth >= t.layout.splitMinimum && width > height && fontScale < 1.3,
    compact: workspaceWidth < 600 || fontScale >= 1.3,
    railWidth: workspaceWidth >= 1180 ? 320 : t.layout.contextRail,
    workspaceWidth,
  };
}
