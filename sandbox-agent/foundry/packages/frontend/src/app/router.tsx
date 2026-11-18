import { type ReactNode, useEffect } from "react";
import type { FoundryBillingPlanId } from "@sandbox-agent/foundry-shared";
import { useSubscription } from "@sandbox-agent/foundry-client";
import { Navigate, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { MockLayout } from "../components/mock-layout";
import {
  MockAccountSettingsPage,
  MockHostedCheckoutPage,
  MockOrganizationBillingPage,
  MockOrganizationSelectorPage,
  MockOrganizationSettingsPage,
  MockSignInPage,
} from "../components/mock-onboarding";
import { defaultOrganizationId, isMockFrontendClient } from "../lib/env";
import { subscriptionManager } from "../lib/subscription";
import { activeMockOrganization, getMockOrganizationById, isAppSnapshotBootstrapping, useMockAppClient, useMockAppSnapshot } from "../lib/mock-app";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRoute,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin",
  component: SignInRoute,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountRoute,
});

const organizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations",
  component: OrganizationsRoute,
});

const organizationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId/settings",
  component: OrganizationSettingsRoute,
});

const organizationBillingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId/billing",
  component: OrganizationBillingRoute,
});

const organizationCheckoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId/checkout/$planId",
  component: OrganizationCheckoutRoute,
});

const organizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId",
  component: OrganizationLayoutRoute,
});

const organizationIndexRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "/",
  component: OrganizationRoute,
});

const taskRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "tasks/$taskId",
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId: typeof search.sessionId === "string" && search.sessionId.trim().length > 0 ? search.sessionId : undefined,
  }),
  component: TaskRoute,
});

const repoRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "repos/$repoId",
  component: RepoRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  accountRoute,
  organizationsRoute,
  organizationSettingsRoute,
  organizationBillingRoute,
  organizationCheckoutRoute,
  organizationRoute.addChildren([organizationIndexRoute, taskRoute, repoRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function OrganizationLayoutRoute() {
  return <Outlet />;
}

function AppLoadingScreen({ label }: { label: string }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at top left, rgba(255, 79, 0, 0.16), transparent 28%), radial-gradient(circle at top right, rgba(24, 140, 255, 0.18), transparent 32%), #050505",
        color: "#ffffff",
        fontSize: "16px",
        fontWeight: 700,
      }}
    >
      {label}
    </div>
  );
}

function IndexRoute() {
  const snapshot = useMockAppSnapshot();
  if (!isMockFrontendClient && isAppSnapshotBootstrapping(snapshot)) {
    return <AppLoadingScreen label="Restoring Foundry session..." />;
  }
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const activeOrganization = activeMockOrganization(snapshot);
  if (activeOrganization) {
    return <Navigate to="/organizations/$organizationId" params={{ organizationId: activeOrganization.organizationId }} replace />;
  }

  return <Navigate to="/organizations" replace />;
}

function SignInRoute() {
  const snapshot = useMockAppSnapshot();
  if (!isMockFrontendClient && isAppSnapshotBootstrapping(snapshot)) {
    return <AppLoadingScreen label="Restoring Foundry session..." />;
  }
  if (snapshot.auth.status === "signed_in") {
    return <IndexRoute />;
  }

  return <MockSignInPage />;
}

function AccountRoute() {
  const snapshot = useMockAppSnapshot();
  if (!isMockFrontendClient && isAppSnapshotBootstrapping(snapshot)) {
    return <AppLoadingScreen label="Loading account..." />;
  }
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  return <MockAccountSettingsPage />;
}

function OrganizationsRoute() {
  const snapshot = useMockAppSnapshot();
  if (!isMockFrontendClient && isAppSnapshotBootstrapping(snapshot)) {
    return <AppLoadingScreen label="Loading organizations..." />;
  }
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  return <MockOrganizationSelectorPage />;
}

function OrganizationSettingsRoute() {
  const snapshot = useMockAppSnapshot();
  if (!isMockFrontendClient && isAppSnapshotBootstrapping(snapshot)) {
    return <AppLoadingScreen label="Loading organization settings..." />;
  }
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const { organizationId } = organizationSettingsRoute.useParams();
  const organization = getMockOrganizationById(snapshot, organizationId);
  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <MockOrganizationSettingsPage organization={organization} />;
}

function OrganizationBillingRoute() {
  const snapshot = useMockAppSnapshot();
  if (!isMockFrontendClient && isAppSnapshotBootstrapping(snapshot)) {
    return <AppLoadingScreen label="Loading billing..." />;
  }
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const { organizationId } = organizationBillingRoute.useParams();
  const organization = getMockOrganizationById(snapshot, organizationId);
  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <MockOrganizationBillingPage organization={organization} />;
}

function OrganizationCheckoutRoute() {
  const snapshot = useMockAppSnapshot();
  if (!isMockFrontendClient && isAppSnapshotBootstrapping(snapshot)) {
    return <AppLoadingScreen label="Loading checkout..." />;
  }
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const { organizationId, planId } = organizationCheckoutRoute.useParams();
  const organization = getMockOrganizationById(snapshot, organizationId);
  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <MockHostedCheckoutPage organization={organization} planId={planId as FoundryBillingPlanId} />;
}

function OrganizationRoute() {
  const { organizationId } = organizationRoute.useParams();
  return (
    <AppOrganizationGate organizationId={organizationId}>
      <OrganizationView organizationId={organizationId} selectedTaskId={null} selectedSessionId={null} />
    </AppOrganizationGate>
  );
}

function OrganizationView({
  organizationId,
  selectedTaskId,
  selectedSessionId,
}: {
  organizationId: string;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
}) {
  return <MockLayout organizationId={organizationId} selectedTaskId={selectedTaskId} selectedSessionId={selectedSessionId} />;
}

function TaskRoute() {
  const { organizationId, taskId } = taskRoute.useParams();
  const { sessionId } = taskRoute.useSearch();
  return (
    <AppOrganizationGate organizationId={organizationId}>
      <TaskView organizationId={organizationId} taskId={taskId} sessionId={sessionId ?? null} />
    </AppOrganizationGate>
  );
}

function TaskView({ organizationId, taskId, sessionId }: { organizationId: string; taskId: string; sessionId: string | null }) {
  return <MockLayout organizationId={organizationId} selectedTaskId={taskId} selectedSessionId={sessionId} />;
}

function RepoRoute() {
  const { organizationId, repoId } = repoRoute.useParams();
  return (
    <AppOrganizationGate organizationId={organizationId}>
      <RepoRouteInner organizationId={organizationId} repoId={repoId} />
    </AppOrganizationGate>
  );
}

function AppOrganizationGate({ organizationId, children }: { organizationId: string; children: ReactNode }) {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const organization = snapshot.organizations.find((candidate) => candidate.organizationId === organizationId) ?? null;

  useEffect(() => {
    if (organization && snapshot.activeOrganizationId !== organization.id) {
      void client.selectOrganization(organization.id);
    }
  }, [client, organization, snapshot.activeOrganizationId]);

  if (!isMockFrontendClient && isAppSnapshotBootstrapping(snapshot)) {
    return <AppLoadingScreen label="Loading organization..." />;
  }

  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  if (!organization) {
    return isMockFrontendClient ? <Navigate to="/organizations" replace /> : <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function RepoRouteInner({ organizationId, repoId }: { organizationId: string; repoId: string }) {
  const organizationState = useSubscription(subscriptionManager, "organization", { organizationId });
  const activeTaskId = organizationState.data?.taskSummaries.find((task) => task.repoId === repoId)?.id;
  if (!activeTaskId) {
    return <Navigate to="/organizations/$organizationId" params={{ organizationId }} replace />;
  }
  return (
    <Navigate to="/organizations/$organizationId/tasks/$taskId" params={{ organizationId, taskId: activeTaskId }} search={{ sessionId: undefined }} replace />
  );
}

function RootLayout() {
  return (
    <>
      <Outlet />
    </>
  );
}
