// SPDX-License-Identifier: AGPL-3.0
// Borrowed structure (not verbatim) from upstream
// gobifrost/bifrost client/src/pages/ExecutionHistory.tsx (reference:
// vendor/upstream/client). Lists ExecutionHistory rows only: no input/results
// in rows; those live on the detail page.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchExecutionHistory, getToken, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ExecutionHistoryResponse } from "../lib/client-types";
import { StatusBadge } from "../components/StatusBadge";

export function ExecutionHistoryList(props: { initial?: ExecutionHistoryResponse }): React.JSX.Element {
  const [data, setData] = useState<ExecutionHistoryResponse | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await fetchExecutionHistory());
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load history."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  return (
    <section aria-labelledby="history-heading">
      <h1 id="history-heading">Execution history</h1>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          setLoading(true);
          setError(null);
          void fetchExecutionHistory()
            .then((next) => setData(next))
            .catch((err: unknown) => setError(getErrorMessage(err, "Could not load history.")))
            .finally(() => setLoading(false));
        }}
      >
        <label htmlFor="token">Bearer token (local fixture only, never committed)</label>
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setTokenState(e.target.value)}
          placeholder="paste LAB_TOKEN"
        />
        <button type="submit">Reload</button>
      </form>
      {loading ? (
        <p role="status" className="status-line">
          Loading ExecutionHistory…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error} {error.includes("UNIMPLEMENTED") ? <span>(server reports this surface UNIMPLEMENTED)</span> : null}
        </p>
      ) : null}
      {data ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Saga</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Execution</th>
                </tr>
              </thead>
              <tbody>
                {data.executions.map((row) => (
                  <tr key={row.executionId} data-testid="execution-row">
                    <td>
                      <Link to={`/history/${row.executionId}`} className="saga-link">
                        {row.sagaName}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={row.status} />
                    </td>
                    <td>
                      <time className="muted">{row.createdAt}</time>
                    </td>
                    <td>
                      <code className="mono mono--truncate" title={row.executionId}>
                        {row.executionId.slice(0, 12)}…
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.hasMore ? <p className="more-line">More results available.</p> : null}
          {data.executions.length === 0 ? <p className="empty-state">No Executions yet.</p> : null}
        </>
      ) : null}
    </section>
  );
}
