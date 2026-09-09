// SPDX-License-Identifier: AGPL-3.0
import { NavLink } from "react-router-dom";

const REPO = "https://github.com/MTG-Thomas/Wrangnarok";

export interface NavEntry {
  label: string;
  to?: string;
  enabled: boolean;
  issue?: string;
  phase?: string;
}

/**
 * Roadmap-surface nav. Unported entries are visibly disabled AND link their
 * tracking issue so gray-out is honest, not theater. Server enforces the same
 * boundary: unmapped /api/* routes return UNIMPLEMENTED.
 */
export const NAV_ENTRIES: NavEntry[] = [
  { label: "History", to: "/history", enabled: true, phase: "Phase 4 (#17)" },
  {
    label: "Dashboard",
    enabled: false,
    issue: `${REPO}/issues/15`,
    phase: "Phase 4",
  },
  {
    label: "Sagas and Catalog",
    enabled: false,
    issue: `${REPO}/issues/16`,
    phase: "Phase 1 / Phase 4",
  },
  {
    label: "Integrations",
    enabled: false,
    issue: `${REPO}/issues/18`,
    phase: "Phase 2 / Phase 3",
  },
  {
    label: "Connections",
    enabled: false,
    issue: `${REPO}/issues/18`,
    phase: "Phase 3",
  },
  {
    label: "Triggers",
    enabled: false,
    issue: `${REPO}/issues/16`,
    phase: "Phase 2 / Phase 4",
  },
  {
    label: "Tables and Forms",
    enabled: false,
    issue: `${REPO}/issues/15`,
    phase: "Phase 4",
  },
];

export function Nav(): React.JSX.Element {
  return (
    <nav aria-label="Primary" className="nav">
      <span className="brand">Wrangnarök</span>
      <ul>
        {NAV_ENTRIES.map((entry) =>
          entry.enabled && entry.to ? (
            <li key={entry.label}>
              <NavLink to={entry.to}>{entry.label}</NavLink>
            </li>
          ) : (
            <li
              key={entry.label}
              aria-disabled="true"
              title={`${entry.label} — not yet ported (${entry.phase})`}
              className="disabled"
            >
              <span>{entry.label} (soon)</span>{" "}
              {entry.issue ? (
                <a
                  href={entry.issue}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${entry.label} tracking issue`}
                >
                  {entry.issue.split("/").pop()} · {entry.phase}
                </a>
              ) : null}
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
