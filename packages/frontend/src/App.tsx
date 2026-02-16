import { Routes, Route } from "react-router-dom";
import { Home } from "./pages/Home";
import { ProjectSetup } from "./pages/ProjectSetup";
import { ProjectView } from "./pages/ProjectView";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/projects/new" element={<ProjectSetup />} />
      <Route path="/projects/:projectId/:phase?" element={<ProjectView />} />
    </Routes>
  );
}
