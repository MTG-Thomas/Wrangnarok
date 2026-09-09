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
      <h1 id="history-heading">ExecutionHistory</h1>
      <form
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
      {loading ? <p role="status">Loading ExecutionHistory…</p> : null}
      {error ? (
        <p role="alert">
          {error} {error.includes("UNIMPLEMENTED") ? <span>(server reports this surface UNIMPLEMENTED)</span> : null}
        </p>
      ) : null}
      {data ? (
        <>
          <ul aria-label="Executions">
            {data.executions.map((row) => (
              <li key={row.executionId} data-testid="execution-row">
                <Link to={`/history/${row.executionId}`}>
                  {row.sagaName} · {row.status}
                </Link>{" "}
                <span>
                  {row.createdAt} · {row.executionId.slice(0, 12)}…
                </span>
              </li>
            ))}
          </ul>
          {data.hasMore ? <p>More results available.</p> : null}
          {data.executions.length === 0 ? <p>No Executions yet.</p> : null}
        </>
      ) : null}
    </section>
  );
}
