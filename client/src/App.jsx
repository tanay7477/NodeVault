import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout            from './components/Layout';
import Auth              from './pages/Auth';
import Dashboard         from './pages/Dashboard';
import Files             from './pages/Files';
import Cluster           from './pages/Cluster';
import Audit             from './pages/Audit';
import Topology          from './pages/Topology';
import ChaosLab          from './pages/ChaosLab';
import { isAuthenticated, getUser } from './api';

function ProtectedRoute({ children }) {
  return isAuthenticated() ? children : <Navigate to="/login" replace />;
}

function PublicOnlyRoute({ children }) {
  return isAuthenticated() ? <Navigate to="/" replace /> : children;
}

function AdminOnlyRoute({ children }) {
  const user = getUser();
  if (user?.role !== 'admin') {
    return <Navigate to="/files" replace />;
  }
  return children;
}

function RoleBasedHome() {
  const user = getUser();
  if (user?.role !== 'admin') {
    return <Navigate to="/files" replace />;
  }
  return <Dashboard />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<PublicOnlyRoute><Auth /></PublicOnlyRoute>} />
        <Route
          path="/"
          element={<ProtectedRoute><Layout /></ProtectedRoute>}
        >
          <Route index                element={<RoleBasedHome />} />
          <Route path="files"         element={<Files />} />
          <Route path="cluster"       element={<AdminOnlyRoute><Cluster /></AdminOnlyRoute>} />
          <Route path="topology"      element={<AdminOnlyRoute><Topology /></AdminOnlyRoute>} />
          <Route path="chaos"         element={<AdminOnlyRoute><ChaosLab /></AdminOnlyRoute>} />
          <Route path="audit"         element={<AdminOnlyRoute><Audit /></AdminOnlyRoute>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
