// SPDX-License-Identifier: AGPL-3.0
import { Navigate, Route, Routes } from "react-router-dom";
import { Nav } from "./components/Nav";
import { ExecutionDetailView } from "./pages/ExecutionDetail";
import { ExecutionHistoryList } from "./pages/ExecutionHistory";

export function App(): React.JSX.Element {
  return (
    <div className="shell">
      <Nav />
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/history" replace />} />
          <Route path="/history" element={<ExecutionHistoryList />} />
          <Route path="/history/:id" element={<ExecutionDetailView />} />
          <Route path="*" element={<p>Not found. Try History.</p>} />
        </Routes>
      </main>
    </div>
  );
}
