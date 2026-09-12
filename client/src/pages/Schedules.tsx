// SPDX-License-Identifier: AGPL-3.0
// Schedules UI (TRG-01, issue #137): operator list/detail for one-off and
// recurring schedules.
//
// Borrowed structure from client/src/pages/Forms.tsx (token form,
// loading/error states). Lists org-scoped schedules, renders one schedule
// with its delivery ledger (window, Execution linkage), and previews the
// next tick read-only. Creation/mutation ride the typed SDK and the
// Organization-admin boundary server-side; the server stays authoritative
// and every failure surfaces its machine-readable code.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchScheduleDetail, getToken, listSchedules, previewSchedule, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ScheduleDetailResponse, SchedulePreview, SchedulesResponse } from "../lib/client-types";
import { StatusBadge } from "../components/StatusBadge";

export function SchedulesList(props: { initial?: SchedulesResponse }): React.JSX.Element {
  const [data, setData] = useState<SchedulesResponse | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setData(await listSchedules());
    } catch (err) {
      setError(getErrorMessage(err, "Could not load schedules."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await listSchedules());
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load schedules."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  return (
    <section aria-labelledby="schedules-heading">
      <h1 id="schedules-heading">Schedules</h1>
      <p className="muted">
        Org-scoped one-off and recurring schedules. Cadence and enablement are operator policy; promotion runs through
        the standard submit protocol with deterministic derived keys.
      </p>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          void reload();
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
          Loading schedules…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {data ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">State</th>
                  <th scope="col">Next due</th>
                </tr>
              </thead>
              <tbody>
                {data.schedules.map((entry) => (
                  <tr key={entry.id} data-testid="schedule-row">
                    <td>
                      <Link to={`/schedules/${entry.name}`} className="saga-link">
                        {entry.name}
                      </Link>
                      <div className="muted muted--small">
                        {entry.cron ?? "one-off"} · {entry.timezone}
                      </div>
                    </td>
                    <td>
                      <code className="mono">{entry.kind}</code>
                    </td>
                    <td>
                      <StatusBadge status={entry.enabled ? "Pending" : "Cancelled"} />
                      <span className="muted muted--small"> {entry.enabled ? "enabled" : "disabled"}</span>
                    </td>
                    <td>
                      <span className="muted">{entry.nextDueAt ?? "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.schedules.length === 0 ? <p className="empty-state">No schedules yet.</p> : null}
        </>
      ) : null}
    </section>
  );
}

export function ScheduleDetailView(props: { name: string; initial?: ScheduleDetailResponse }): React.JSX.Element {
  const [detail, setDetail] = useState<ScheduleDetailResponse | null>(props.initial ?? null);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setDetail(await fetchScheduleDetail(props.name));
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load schedule."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial, props.name]);

  async function onPreview(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      if (!detail) return;
      const body =
        detail.schedule.kind === "one-off"
          ? { kind: "one-off" as const, dueAt: detail.schedule.nextDueAt ?? new Date().toISOString() }
          : {
              kind: "recurring" as const,
              cron: detail.schedule.cron ?? "* * * * *",
              timezone: detail.schedule.timezone,
            };
      setPreview(await previewSchedule(body));
    } catch (err) {
      setError(getErrorMessage(err, "Could not preview schedule."));
    }
  }

  return (
    <section aria-labelledby="schedule-heading">
      <h1 id="schedule-heading">Schedule {props.name}</h1>
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {detail ? (
        <>
          <dl className="detail-list">
            <div>
              <dt>Kind</dt>
              <dd>
                <code className="mono">{detail.schedule.kind}</code>
              </dd>
            </div>
            <div>
              <dt>Cadence</dt>
              <dd>
                <code className="mono">
                  {detail.schedule.cron ?? detail.schedule.nextDueAt ?? "—"} · {detail.schedule.timezone}
                </code>
              </dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{detail.schedule.enabled ? "enabled" : "disabled"}</dd>
            </div>
          </dl>
          <p>
            <button type="button" onClick={() => void onPreview()}>
              Preview next tick
            </button>
          </p>
          {preview ? (
            <p className="muted" data-testid="schedule-preview">
              Next: {preview.nextDueAt ?? preview.dueAt ?? "—"}
              {preview.utcShifted ? " (UTC-shifted ticks)" : ""}
            </p>
          ) : null}
          <h2>Deliveries</h2>
          {detail.deliveries.length === 0 ? (
            <p className="empty-state">No windows promoted yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th scope="col">Window</th>
                    <th scope="col">Execution</th>
                    <th scope="col">Promoted</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.deliveries.map((delivery) => (
                    <tr key={`${delivery.window}-${delivery.executionId}`}>
                      <td>
                        <code className="mono">{delivery.window}</code>
                      </td>
                      <td>
                        <Link to={`/history/${delivery.executionId}`} className="saga-link">
                          {delivery.executionId.slice(0, 12)}…
                        </Link>
                      </td>
                      <td>
                        <span className="muted">{delivery.createdAt}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p role="status" className="status-line">
          Loading schedule…
        </p>
      )}
    </section>
  );
}
