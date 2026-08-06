import { Page } from "@dynatrace/strato-components-preview";
import { Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { LandingPage } from "./pages/LandingPage";
import { DiskAuditPage } from "./pages/DiskAuditPage";
import { ComputeRightSizingPage } from "./pages/ComputeRightSizingPage";
import { KubernetesDensityPage } from "./pages/KubernetesDensityPage";
import { ScalingBoundariesPage } from "./pages/ScalingBoundariesPage";
import { ScopeProvider } from "./contexts/ScopeContext";

export const App = () => (
  <ScopeProvider>
    <Page>
      <Page.Header>
        <Header />
      </Page.Header>
      <Page.Main>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/disk" element={<DiskAuditPage />} />
          <Route path="/compute" element={<ComputeRightSizingPage />} />
          <Route path="/kubernetes" element={<KubernetesDensityPage />} />
          <Route path="/scaling" element={<ScalingBoundariesPage />} />
        </Routes>
      </Page.Main>
    </Page>
  </ScopeProvider>
);
