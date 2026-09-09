// SPDX-License-Identifier: AGPL-3.0
// Borrowed structure (not verbatim) from upstream
// gobifrost/bifrost client/src/pages/ExecutionDetails.tsx (reference:
// vendor/upstream/client). Detail surface: status, Operations, runtimeStatus.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchExecutionDetail } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ExecutionDetail as Detail } from "../lib/client-types";

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
      <Link to="/history">Back to ExecutionHistory</Link>
      <h1 id="detail-heading">Execution detail</h1>
      {loading ? <p role="status">Loading Execution…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {data ? (
        <article data-testid="execution-detail">
          <dl>
            <dt>Saga</dt>
            <dd>
              {data.sagaName} ({data.sagaRevision})
            </dd>
            <dt>Status</dt>
            <dd>{data.status}</dd>
            <dt>Runtime status</dt>
            <dd>{data.runtimeStatus ?? "unavailable"}</dd>
            <dt>Execution</dt>
            <dd>{data.executionId}</dd>
            <dt>Organization</dt>
            <dd>{data.orgId}</dd>
          </dl>
          <h2>Operations</h2>
          {data.operations.length === 0 ? (
            <p>No Operations recorded yet.</p>
          ) : (
            <ul aria-label="Operations">
              {data.operations.map((op) => (
                <li key={op.name} data-testid="operation-row">
                  {op.name} · {op.status} · started {op.startedAt}
                </li>
              ))}
            </ul>
          )}
        </article>
      ) : null}
    </section>
  );
}
