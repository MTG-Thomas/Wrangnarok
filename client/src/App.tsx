// SPDX-License-Identifier: AGPL-3.0
import { Navigate, Route, Routes } from "react-router-dom";
import { Nav } from "./components/Nav";
import { AdminOrgs } from "./pages/AdminOrgs";
import { ApplicationDetailView, ApplicationsList } from "./pages/Applications";
import { ExecutionDetailView } from "./pages/ExecutionDetail";
import { ExecutionHistoryList } from "./pages/ExecutionHistory";
import { FilesList } from "./pages/Files";
import { SagasList } from "./pages/Sagas";

export function App(): React.JSX.Element {
  return (
    <div className="shell">
      <Nav />
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/history" replace />} />
          <Route path="/history" element={<ExecutionHistoryList />} />
          <Route path="/history/:id" element={<ExecutionDetailView />} />
          <Route path="/sagas" element={<SagasList />} />
          <Route path="/admin" element={<AdminOrgs />} />
          <Route path="/apps" element={<ApplicationsList />} />
          <Route path="/apps/:id" element={<ApplicationDetailView />} />
          <Route path="/files" element={<FilesList />} />
          <Route path="*" element={<p>Not found. Try History.</p>} />
        </Routes>
      </main>
    </div>
  );
}
