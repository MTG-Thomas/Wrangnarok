// SPDX-License-Identifier: AGPL-3.0
// Presentation-only status badge. Status is always rendered as text plus a
// decorative glyph so state is never conveyed by color alone.
import type { ExecutionStatus } from "../lib/client-types";

const KNOWN_STATUSES: ReadonlySet<string> = new Set<string>([
  "Succeeded",
  "Failed",
  "Running",
  "Pending",
  "Cancelled",
  "TimedOut",
]);

const GLYPHS: Readonly<Record<string, string>> = {
  Succeeded: "✓",
  Failed: "✕",
  Running: "●",
  Pending: "○",
  Cancelled: "■",
  TimedOut: "◷",
};

export function StatusBadge({ status }: { status: ExecutionStatus | string }): React.JSX.Element {
  const modifier = KNOWN_STATUSES.has(status) ? `badge--${status.toLowerCase()}` : "badge--unknown";
  const glyph = GLYPHS[status] ?? "•";
  return (
    <span className={`badge ${modifier}`}>
      <span aria-hidden="true" className="badge-glyph">
        {glyph}
      </span>
      {status}
    </span>
  );
}
