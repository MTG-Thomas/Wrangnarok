// SPDX-License-Identifier: AGPL-3.0
// Borrowed structure (not verbatim) from client/src/pages/ExecutionHistory.tsx
// (token form, loading/error/empty states, truncated-mono ID + tooltip table
// pattern). Read-only display notes only from upstream gobifrost/bifrost
// client/src/pages/ExecuteWorkflow.tsx — fetched via
// `gh api repos/gobifrost/bifrost/contents/client/src/pages/ExecuteWorkflow.tsx`
// because the vendor/upstream submodule is absent in this worktree. Only its
// read-only surface fits here (heading + description, loading/error states,
// error mapping); none of its execute/schedule/parameter-form behavior is
// ported. Lists Sagas only: no execution, no mutation.
import { useEffect, useState } from "react";
import { getToken, listSagas, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { SagasResponse } from "../lib/client-types";

export function SagasList(props: { initial?: SagasResponse }): React.JSX.Element {
  const [data, setData] = useState<SagasResponse | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await listSagas());
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load Sagas."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  return (
    <section aria-labelledby="sagas-heading">
      <h1 id="sagas-heading">Sagas</h1>
      <p className="muted">Read-only catalog of the Sagas this Worker serves.</p>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          setLoading(true);
          setError(null);
          void listSagas()
            .then((next) => setData(next))
            .catch((err: unknown) => setError(getErrorMessage(err, "Could not load Sagas.")))
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
          Loading Sagas…
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
                  <th scope="col">ID</th>
                  <th scope="col">Revision</th>
                  <th scope="col">Requires</th>
                  <th scope="col">Description</th>
                </tr>
              </thead>
              <tbody>
                {data.sagas.map((saga) => (
                  <tr key={saga.id} data-testid="saga-row">
                    <td>
                      <span className="saga-link">{saga.name}</span>
                    </td>
                    <td>
                      <code className="mono mono--truncate" title={saga.id}>
                        {saga.id.slice(0, 12)}…
                      </code>
                    </td>
                    <td>
                      <span className="muted">{saga.revision}</span>
                    </td>
                    <td>
                      {saga.requiredIntegrations.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        saga.requiredIntegrations.map((integrationId) => (
                          <code key={integrationId} className="mono mono--truncate" title={integrationId}>
                            {integrationId.slice(0, 8)}…{" "}
                          </code>
                        ))
                      )}
                    </td>
                    <td>{saga.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.sagas.length === 0 ? <p className="empty-state">No Sagas registered yet.</p> : null}
        </>
      ) : null}
    </section>
  );
}
