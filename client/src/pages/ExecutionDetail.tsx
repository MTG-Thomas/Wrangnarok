// SPDX-License-Identifier: AGPL-3.0
// Borrowed structure (not verbatim) from upstream
// gobifrost/bifrost client/src/pages/ExecutionDetails.tsx (reference:
// vendor/upstream/client). Detail surface: status, Operations, runtimeStatus.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchExecutionDetail } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ExecutionDetail as Detail } from "../lib/client-types";
import { StatusBadge } from "../components/StatusBadge";

export function ExecutionDetailView(props: { initial?: Detail }): React.JSX.Element {
  const params = useParams();
  const id = props.initial?.executionId ?? params["id"] ?? "";
  const [data, setData] = useState<Detail | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await fetchExecutionDetail(id));
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load Execution."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial, id]);

  return (
    <section aria-labelledby="detail-heading">
      <Link to="/history" className="back-link">
        ← Back to Execution history
      </Link>
      <h1 id="detail-heading">Execution detail</h1>
      {loading ? (
        <p role="status" className="status-line">
          Loading Execution…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {data ? (
        <article data-testid="execution-detail">
          <dl className="detail-grid">
            <dt>Saga</dt>
            <dd>
              {data.sagaName} ({data.sagaRevision})
            </dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Runtime status</dt>
            <dd className="muted">{data.runtimeStatus ?? "unavailable"}</dd>
            <dt>Execution</dt>
            <dd>
              <code className="mono mono--wrap" title={data.executionId}>
                {data.executionId}
              </code>
            </dd>
            <dt>Organization</dt>
            <dd>
              <code className="mono mono--wrap" title={data.orgId}>
                {data.orgId}
              </code>
            </dd>
          </dl>
          <h2>Operations</h2>
          {data.operations.length === 0 ? (
            <p className="empty-state">No Operations recorded yet.</p>
          ) : (
            <ul aria-label="Operations" className="ops-list">
              {data.operations.map((op) => (
                <li key={op.name} data-testid="operation-row" className="op-row">
                  <span className="op-name">{op.name}</span>
                  <StatusBadge status={op.status} />
                  <time className="muted">started {op.startedAt}</time>
                </li>
              ))}
            </ul>
          )}
        </article>
      ) : null}
    </section>
  );
}
