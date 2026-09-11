import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { AgentDetailPage } from "@/routes/agents/agent-detail";
import { AgentListPage } from "@/routes/agents/agent-list";
import { DeploymentDetailPage } from "@/routes/deployments/deployment-detail";
import { DeploymentListPage } from "@/routes/deployments/deployment-list";
import { SettingsPage } from "@/routes/settings/settings";
import { NotFoundPage } from "@/routes/not-found";
import { SessionDetailPage } from "@/routes/sessions/session-detail";
import { SessionListPage } from "@/routes/sessions/session-list";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <Navigate replace to="/agents" /> },
      {
        path: "agents",
        children: [
          { index: true, element: <AgentListPage /> },
          { path: ":agentId", element: <AgentDetailPage /> },
        ],
      },
      {
        path: "sessions",
        children: [
          { index: true, element: <SessionListPage /> },
          { path: ":sessionId", element: <SessionDetailPage /> },
        ],
      },
      {
        path: "deployments",
        children: [
          { index: true, element: <DeploymentListPage /> },
          { path: ":deploymentId", element: <DeploymentDetailPage /> },
        ],
      },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
