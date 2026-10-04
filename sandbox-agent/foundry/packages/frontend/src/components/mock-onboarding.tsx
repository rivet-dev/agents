import { useCallback, useEffect, useMemo, useState } from "react";
import { type FoundryBillingPlanId, type FoundryOrganization, type FoundryOrganizationMember, type FoundryUser } from "@sandbox-agent/foundry-shared";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Clock, CreditCard, FileText, Github, LogOut, Moon, Settings, Sun, Users } from "lucide-react";
import { activeMockUser, eligibleOrganizations, useMockAppClient, useMockAppSnapshot } from "../lib/mock-app";
import { isMockFrontendClient } from "../lib/env";
import { useColorMode, useFoundryTokens } from "../app/theme";
import type { FoundryTokens } from "../styles/tokens";
import { appSurfaceStyle, primaryButtonStyle, secondaryButtonStyle, subtleButtonStyle, cardStyle, badgeStyle, inputStyle } from "../styles/shared-styles";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const planCatalog: Record<
  FoundryBillingPlanId,
  {
    label: string;
    price: string;
    pricePerMonth: number;
    seats: string;
    taskHours: number;
    summary: string;
  }
> = {
  free: {
    label: "Free",
    price: "$0",
    pricePerMonth: 0,
    seats: "1 seat included",
    taskHours: 8,
    summary: "Get started with up to 8 task hours per month.",
  },
  team: {
    label: "Pro",
    price: "$25/mo",
    pricePerMonth: 25,
    seats: "per seat",
    taskHours: 200,
    summary: "200 task hours per seat, with the ability to purchase additional hours.",
  },
};

const taskHourPackages = [
  { hours: 50, price: 6 },
  { hours: 100, price: 12 },
  { hours: 200, price: 24 },
  { hours: 400, price: 48 },
  { hours: 600, price: 72 },
  { hours: 1000, price: 120 },
];

function DesktopDragRegion() {
  const isDesktop = !!import.meta.env.VITE_DESKTOP;
  const onDragMouseDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const ipc = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as
      | {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        }
      | undefined;
    if (ipc?.invoke) {
      ipc.invoke("plugin:window|start_dragging").catch(() => {});
    }
  }, []);

  if (!isDesktop) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "38px",
        zIndex: 9998,
        pointerEvents: "none",
      }}
    >
      <div
        onPointerDown={onDragMouseDown}
        style={
          {
            position: "absolute",
            inset: 0,
            WebkitAppRegion: "drag",
            pointerEvents: "auto",
            zIndex: 0,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) {
    return "N/A";
  }
  return dateFormatter.format(new Date(value));
}

function organizationPath(organization: FoundryOrganization): string {
  return `/organizations/${organization.organizationId}`;
}

function settingsPath(organization: FoundryOrganization): string {
  return `/organizations/${organization.id}/settings`;
}

function billingPath(organization: FoundryOrganization): string {
  return `/organizations/${organization.id}/billing`;
}

function checkoutPath(organization: FoundryOrganization, planId: FoundryBillingPlanId): string {
  return `/organizations/${organization.id}/checkout/${planId}`;
}

function statusBadge(t: FoundryTokens, organization: FoundryOrganization) {
  if (organization.kind === "personal") {
    return <span style={badgeStyle(t, "rgba(24, 140, 255, 0.18)", "#b9d8ff")}>Personal organization</span>;
  }
  return <span style={badgeStyle(t, "rgba(255, 79, 0, 0.16)", "#ffd6c7")}>GitHub organization</span>;
}

function githubBadge(t: FoundryTokens, organization: FoundryOrganization) {
  if (organization.github.installationStatus === "connected") {
    return <span style={badgeStyle(t, "rgba(46, 160, 67, 0.16)", "#b7f0c3")}>GitHub connected</span>;
  }
  if (organization.github.installationStatus === "reconnect_required") {
    return <span style={badgeStyle(t, "rgba(255, 193, 7, 0.18)", "#ffe6a6")}>Reconnect required</span>;
  }
  return <span style={badgeStyle(t, t.borderSubtle)}>Install GitHub App</span>;
}

function StatCard({ label, value, caption }: { label: string; value: string; caption: string }) {
  const t = useFoundryTokens();
  return (
    <div
      style={{
        ...cardStyle(t),
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      }}
    >
      <div style={{ fontSize: "10px", color: t.textTertiary, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: "16px", fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: "11px", color: t.textTertiary, lineHeight: 1.5 }}>{caption}</div>
    </div>
  );
}

function MemberRow({ member }: { member: FoundryOrganizationMember }) {
  const t = useFoundryTokens();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) 100px",
        gap: "10px",
        padding: "8px 0",
        borderTop: `1px solid ${t.borderSubtle}`,
        alignItems: "center",
      }}
    >
      <div>
        <div style={{ fontWeight: 500, fontSize: "12px" }}>{member.name}</div>
        <div style={{ color: t.textSecondary, fontSize: "11px" }}>{member.email}</div>
      </div>
      <div style={{ color: t.textSecondary, fontSize: "12px", textTransform: "capitalize" }}>{member.role}</div>
      <div>
        <span
          style={badgeStyle(
            t,
            member.state === "active" ? "rgba(46, 160, 67, 0.16)" : "rgba(255, 193, 7, 0.18)",
            member.state === "active" ? "#b7f0c3" : "#ffe6a6",
          )}
        >
          {member.state}
        </span>
      </div>
    </div>
  );
}

export function MockSignInPage() {
  const client = useMockAppClient();
  const navigate = useNavigate();
  const t = useFoundryTokens();

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: t.surfacePrimary,
        fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
        color: t.textPrimary,
      }}
    >
      <DesktopDragRegion />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          width: "100%",
          maxWidth: "320px",
        }}
      >
        {/* Foundry icon */}
        <svg width="48" height="48" viewBox="0 0 130 128" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginBottom: "24px" }}>
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M88.0429 44.2658C89.3803 43.625 90.8907 44.1955 91.5731 45.3776C92.2556 46.5596 91.9945 48.1529 90.7709 48.9907L72.3923 62.885C71.8013 63.2262 71.4248 63.7062 71.1029 64.2861C70.781 64.8659 70.5554 65.3922 70.5443 66.0553L67.7403 88.9495C67.521 90.3894 66.4114 91.423 64.9867 91.4576C63.5619 91.4922 62.3731 90.3429 62.24 88.9751L59.3859 66.0642C59.3971 65.4011 59.2126 64.8489 58.8714 64.2579C58.5302 63.6669 58.1442 63.231 57.5643 62.9091L39.15 48.9819C38.032 48.1828 37.6311 46.5786 38.3734 45.362C39.1157 44.1454 40.5656 43.7013 41.9223 44.2314L63.1512 53.2502C63.731 53.5721 64.2996 53.6398 64.9627 53.651C65.6259 53.6622 66.2298 53.5761 66.8208 53.2349L88.0429 44.2658Z"
            fill="white"
          />
          <rect x="19.25" y="18.25" width="91.5" height="91.5" rx="25.75" stroke="#F0F0F0" strokeWidth="8.5" />
        </svg>

        <h1
          style={{
            fontSize: "20px",
            fontWeight: 600,
            color: t.textPrimary,
            margin: "0 0 8px 0",
            letterSpacing: "-0.01em",
          }}
        >
          Sign in to Sandbox Agent Foundry
        </h1>

        <p
          style={{
            fontSize: "13px",
            fontWeight: 400,
            color: t.textTertiary,
            margin: "0 0 32px 0",
            lineHeight: 1.5,
          }}
        >
          Connect your GitHub account to get started.
        </p>

        {/* GitHub sign-in button */}
        <button
          type="button"
          onClick={() => {
            void (async () => {
              await client.signInWithGithub(isMockFrontendClient ? "user-nathan" : undefined);
              if (isMockFrontendClient) {
                await navigate({ to: "/organizations" });
              }
            })();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            width: "100%",
            height: "44px",
            padding: "0 20px",
            background: t.textPrimary,
            color: t.textOnPrimary,
            border: "none",
            borderRadius: "8px",
            fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
            fontSize: "14px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <Github size={20} />
          Continue with GitHub
        </button>

        {/* Footer */}
        <a
          href="https://sandbox-agent.dev"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginTop: "32px",
            fontSize: "13px",
            color: t.textTertiary,
            textDecoration: "none",
          }}
        >
          Learn more
        </a>
      </div>
    </div>
  );
}

export function MockOrganizationSelectorPage() {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const organizations: FoundryOrganization[] = eligibleOrganizations(snapshot);
  const navigate = useNavigate();
  const t = useFoundryTokens();

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: t.surfacePrimary,
        fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
        color: t.textPrimary,
      }}
    >
      <DesktopDragRegion />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          maxWidth: "400px",
          padding: "0 24px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "40px" }}>
          <svg width="40" height="40" viewBox="0 0 130 128" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginBottom: "20px" }}>
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M88.0429 44.2658C89.3803 43.625 90.8907 44.1955 91.5731 45.3776C92.2556 46.5596 91.9945 48.1529 90.7709 48.9907L72.3923 62.885C71.8013 63.2262 71.4248 63.7062 71.1029 64.2861C70.781 64.8659 70.5554 65.3922 70.5443 66.0553L67.7403 88.9495C67.521 90.3894 66.4114 91.423 64.9867 91.4576C63.5619 91.4922 62.3731 90.3429 62.24 88.9751L59.3859 66.0642C59.3971 65.4011 59.2126 64.8489 58.8714 64.2579C58.5302 63.6669 58.1442 63.231 57.5643 62.9091L39.15 48.9819C38.032 48.1828 37.6311 46.5786 38.3734 45.362C39.1157 44.1454 40.5656 43.7013 41.9223 44.2314L63.1512 53.2502C63.731 53.5721 64.2996 53.6398 64.9627 53.651C65.6259 53.6622 66.2298 53.5761 66.8208 53.2349L88.0429 44.2658Z"
              fill="white"
            />
            <rect x="19.25" y="18.25" width="91.5" height="91.5" rx="25.75" stroke="#F0F0F0" strokeWidth="8.5" />
          </svg>
          <h1 style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 6px 0", letterSpacing: "-0.01em" }}>Select a organization</h1>
          <p style={{ fontSize: "13px", color: t.textTertiary, margin: 0 }}>Choose where you want to work.</p>
        </div>

        {/* Organization list */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderRadius: "12px",
            border: `1px solid ${t.borderSubtle}`,
            overflow: "hidden",
          }}
        >
          {organizations.map((organization, index) => (
            <button
              key={organization.id}
              type="button"
              onClick={() => {
                void (async () => {
                  await client.selectOrganization(organization.id);
                  await navigate({ to: organizationPath(organization) });
                })();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "14px",
                padding: "16px 18px",
                background: t.surfaceSecondary,
                border: "none",
                borderTop: index > 0 ? `1px solid ${t.borderSubtle}` : "none",
                color: t.textPrimary,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
                transition: "background 150ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = t.interactiveSubtle;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = t.surfaceSecondary;
              }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "10px",
                  background: organization.kind === "personal" ? "linear-gradient(135deg, #3b82f6, #6366f1)" : "linear-gradient(135deg, #f97316, #ef4444)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "14px",
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {organization.settings.displayName.charAt(0).toUpperCase()}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "14px", fontWeight: 500, lineHeight: 1.3 }}>{organization.settings.displayName}</div>
                <div style={{ fontSize: "12px", color: t.textTertiary, lineHeight: 1.3, marginTop: "1px" }}>
                  {organization.kind === "personal" ? "Personal" : "Organization"} · {planCatalog[organization.billing.planId]!.label} ·{" "}
                  {organization.members.length} member{organization.members.length !== 1 ? "s" : ""}
                </div>
              </div>

              {/* Arrow */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke={t.textTertiary}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "center", marginTop: "24px", gap: "16px" }}>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await client.signOut();
                await navigate({ to: "/signin" });
              })();
            }}
            style={{
              background: "none",
              border: "none",
              color: t.textTertiary,
              fontSize: "13px",
              cursor: "pointer",
              fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
              padding: 0,
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

type SettingsSection = "settings" | "members" | "billing" | "docs";

function SettingsNavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  const t = useFoundryTokens();
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        padding: "5px 10px",
        borderRadius: "6px",
        border: "none",
        background: active ? t.interactiveHover : "transparent",
        color: active ? t.textPrimary : t.textMuted,
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: active ? 500 : 400,
        textAlign: "left",
        fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
        transition: "all 120ms ease",
        lineHeight: 1.4,
      }}
      onMouseEnter={(event) => {
        if (!active) event.currentTarget.style.backgroundColor = t.interactiveSubtle;
      }}
      onMouseLeave={(event) => {
        if (!active) event.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function SettingsContentSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const t = useFoundryTokens();
  return (
    <div>
      <h2 style={{ margin: "0 0 2px", fontSize: "13px", fontWeight: 600, color: t.textPrimary }}>{title}</h2>
      {description ? <p style={{ margin: "0 0 12px", fontSize: "11px", color: t.textMuted, lineHeight: 1.5 }}>{description}</p> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>{children}</div>
    </div>
  );
}

function SettingsRow({ label, description, action }: { label: string; description?: string; action?: React.ReactNode }) {
  const t = useFoundryTokens();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "10px 12px",
        borderRadius: "6px",
        border: `1px solid ${t.borderSubtle}`,
        background: t.interactiveSubtle,
      }}
    >
      <div>
        <div style={{ fontSize: "12px", fontWeight: 500 }}>{label}</div>
        {description ? <div style={{ fontSize: "11px", color: t.textMuted, marginTop: "1px" }}>{description}</div> : null}
      </div>
      {action ?? null}
    </div>
  );
}

function SettingsLayout({
  organization,
  activeSection,
  onSectionChange,
  children,
}: {
  organization: FoundryOrganization;
  activeSection: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  children: React.ReactNode;
}) {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const user = activeMockUser(snapshot);
  const navigate = useNavigate();
  const t = useFoundryTokens();

  const navSections: Array<{ section: SettingsSection; icon: React.ReactNode; label: string }> = [
    { section: "settings", icon: <Settings size={13} />, label: "Settings" },
    { section: "members", icon: <Users size={13} />, label: "Members" },
    { section: "billing", icon: <CreditCard size={13} />, label: "Billing & Invoices" },
    { section: "docs", icon: <FileText size={13} />, label: "Docs" },
  ];

  return (
    <div style={appSurfaceStyle(t)}>
      <DesktopDragRegion />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Left nav */}
        <div
          style={{
            width: "200px",
            flexShrink: 0,
            borderRight: `1px solid ${t.borderSubtle}`,
            padding: "44px 10px 16px",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            overflowY: "auto",
          }}
        >
          {/* Back to organization */}
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await client.selectOrganization(organization.id);
                await navigate({ to: organizationPath(organization) });
              })();
            }}
            style={{
              ...subtleButtonStyle(t),
              display: "flex",
              alignItems: "center",
              gap: "5px",
              marginBottom: "10px",
              fontSize: "11px",
            }}
          >
            <ArrowLeft size={12} />
            Back to organization
          </button>

          {/* User header */}
          <div style={{ padding: "2px 10px 12px", display: "flex", flexDirection: "column", gap: "1px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600 }}>{user?.name ?? "User"}</span>
            <span style={{ fontSize: "10px", color: t.textMuted }}>
              {planCatalog[organization.billing.planId]?.label ?? "Free"} Plan · {user?.email ?? ""}
            </span>
          </div>

          {navSections.map((item) => (
            <SettingsNavItem
              key={item.section}
              icon={item.icon}
              label={item.label}
              active={activeSection === item.section}
              onClick={() => {
                if (item.section === "billing") {
                  void navigate({ to: billingPath(organization) });
                } else if (onSectionChange) {
                  onSectionChange(item.section);
                } else {
                  void navigate({ to: settingsPath(organization) });
                }
              }}
            />
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "80px 36px 40px" }}>
          <div style={{ maxWidth: "560px" }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export function MockOrganizationSettingsPage({ organization }: { organization: FoundryOrganization }) {
  const client = useMockAppClient();
  const navigate = useNavigate();
  const t = useFoundryTokens();
  const [section, setSection] = useState<SettingsSection>("settings");
  const [displayName, setDisplayName] = useState(organization.settings.displayName);
  const [slug, setSlug] = useState(organization.settings.slug);
  const [primaryDomain, setPrimaryDomain] = useState(organization.settings.primaryDomain);

  useEffect(() => {
    setDisplayName(organization.settings.displayName);
    setSlug(organization.settings.slug);
    setPrimaryDomain(organization.settings.primaryDomain);
  }, [organization.id, organization.settings.displayName, organization.settings.slug, organization.settings.primaryDomain]);

  return (
    <SettingsLayout organization={organization} activeSection={section} onSectionChange={setSection}>
      {section === "settings" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div>
            <h1 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 600 }}>Settings</h1>
          </div>

          <SettingsContentSection title="Organization Profile">
            <label style={{ display: "grid", gap: "4px" }}>
              <span style={{ fontSize: "11px", fontWeight: 500, color: t.textMuted }}>Display name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} style={inputStyle(t)} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <label style={{ display: "grid", gap: "4px" }}>
                <span style={{ fontSize: "11px", fontWeight: 500, color: t.textMuted }}>Slug</span>
                <input value={slug} onChange={(event) => setSlug(event.target.value)} style={inputStyle(t)} />
              </label>
              <label style={{ display: "grid", gap: "4px" }}>
                <span style={{ fontSize: "11px", fontWeight: 500, color: t.textMuted }}>Primary domain</span>
                <input value={primaryDomain} onChange={(event) => setPrimaryDomain(event.target.value)} style={inputStyle(t)} />
              </label>
            </div>
            <div>
              <button
                type="button"
                onClick={() =>
                  void client.updateOrganizationProfile({
                    organizationId: organization.id,
                    displayName,
                    slug,
                    primaryDomain,
                  })
                }
                style={primaryButtonStyle(t)}
              >
                Save changes
              </button>
            </div>
          </SettingsContentSection>

          <AppearanceSection />

          <SettingsContentSection
            title="GitHub"
            description={`Connected as ${organization.github.connectedAccount}. ${organization.github.importedRepoCount} repos imported.`}
          >
            <SettingsRow label="Installation status" description={`Last sync: ${organization.github.lastSyncLabel}`} action={githubBadge(t, organization)} />
            <div style={{ display: "flex", gap: "8px" }}>
              <button type="button" onClick={() => void client.reconnectGithub(organization.id)} style={secondaryButtonStyle(t)}>
                Reconnect GitHub
              </button>
              <button type="button" onClick={() => void client.triggerGithubSync(organization.id)} style={subtleButtonStyle(t)}>
                Sync repos
              </button>
            </div>
          </SettingsContentSection>

          <SettingsContentSection title="Sandbox Agent" description="Connect to Sandbox Agent for cloud development environments.">
            <SettingsRow
              label="Sandbox Agent connection"
              description="Manage your Sandbox Agent integration and API keys."
              action={
                <button type="button" onClick={() => window.open("https://sandbox-agent.dev", "_blank", "noopener,noreferrer")} style={secondaryButtonStyle(t)}>
                  Configure
                </button>
              }
            />
          </SettingsContentSection>

          <SettingsContentSection title="More">
            <SettingsRow
              label="Delete organization"
              description="Permanently delete this organization and all its data."
              action={
                <button
                  type="button"
                  style={{
                    ...secondaryButtonStyle(t),
                    borderColor: "rgba(255, 110, 110, 0.24)",
                    color: t.statusError,
                  }}
                >
                  Delete
                </button>
              }
            />
          </SettingsContentSection>
        </div>
      ) : null}

      {section === "members" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div>
            <h1 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 600 }}>Members</h1>
            <p style={{ margin: 0, fontSize: "11px", color: t.textMuted }}>
              {organization.members.length} member{organization.members.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {organization.members.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </div>

          {/* Upgrade CTA for free plan */}
          {!organization.billing.stripeCustomerId.trim() ? (
            <div
              style={{
                ...cardStyle(t),
                padding: "20px",
                border: "1px solid rgba(99, 102, 241, 0.3)",
                background: "linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(139, 92, 246, 0.04) 100%)",
              }}
            >
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>Invite your team</div>
              <div style={{ fontSize: "11px", color: t.textSecondary, lineHeight: 1.6, marginBottom: "14px" }}>
                Upgrade to Pro to add team members and unlock collaboration features:
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
                {[
                  "Hand off tasks to teammates for review or continuation",
                  "Shared organization with unified billing across your org",
                  "200 task hours per seat, with bulk hour purchases available",
                  "Collaborative task history and audit trail",
                ].map((feature) => (
                  <div key={feature} style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#6366f1", fontSize: "14px", lineHeight: 1.2, flexShrink: 0 }}>+</span>
                    <span style={{ fontSize: "11px", color: t.textSecondary, lineHeight: 1.5 }}>{feature}</span>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => void navigate({ to: checkoutPath(organization, "team") })} style={primaryButtonStyle(t)}>
                Upgrade to Pro — $25/mo per seat
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {section === "docs" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div>
            <h1 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 600 }}>Docs</h1>
            <p style={{ margin: 0, fontSize: "11px", color: t.textMuted }}>Documentation and resources.</p>
          </div>
          <SettingsRow
            label="Sandbox Agent Documentation"
            description="Learn about Sandbox Agent features, APIs, and integrations."
            action={
              <button type="button" onClick={() => window.open("https://sandbox-agent.dev", "_blank", "noopener,noreferrer")} style={secondaryButtonStyle(t)}>
                Open docs
              </button>
            }
          />
        </div>
      ) : null}
    </SettingsLayout>
  );
}

export function MockOrganizationBillingPage({ organization }: { organization: FoundryOrganization }) {
  const client = useMockAppClient();
  const navigate = useNavigate();
  const t = useFoundryTokens();
  const hasStripeCustomer = organization.billing.stripeCustomerId.trim().length > 0;
  const effectivePlanId: FoundryBillingPlanId = hasStripeCustomer ? organization.billing.planId : "free";
  const currentPlan = planCatalog[effectivePlanId]!;
  // Mock usage data
  const taskHoursUsed = effectivePlanId === "free" ? 5.2 : 147.3;
  const taskHoursIncluded = currentPlan.taskHours;
  const taskHoursRemaining = Math.max(0, taskHoursIncluded - taskHoursUsed);
  const usagePercent = Math.min(100, (taskHoursUsed / taskHoursIncluded) * 100);
  const isOverage = taskHoursUsed > taskHoursIncluded;
  const isFree = effectivePlanId === "free";

  return (
    <SettingsLayout organization={organization} activeSection="billing">
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <div>
          <h1 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 600 }}>Billing & Invoices</h1>
          <p style={{ margin: 0, fontSize: "11px", color: t.textMuted }}>Manage your plan, task hours, and invoices.</p>
        </div>

        {/* Overview stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
          <StatCard label="Current plan" value={currentPlan.label} caption={isFree ? "Free tier" : `${currentPlan.price} per seat`} />
          <StatCard label="Task hours used" value={`${taskHoursUsed.toFixed(1)}h`} caption={`of ${taskHoursIncluded}h included`} />
          <StatCard
            label="Remaining"
            value={`${taskHoursRemaining.toFixed(1)}h`}
            caption={isOverage ? "Overage — $0.12/min" : `Resets ${formatDate(organization.billing.renewalAt)}`}
          />
        </div>

        {/* Task hours usage bar */}
        <div style={{ ...cardStyle(t), padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Clock size={13} style={{ color: t.textSecondary }} />
              <span style={{ fontSize: "12px", fontWeight: 600 }}>Task Hours</span>
            </div>
            <span style={{ fontSize: "11px", color: t.textSecondary }}>
              {taskHoursUsed.toFixed(1)} / {taskHoursIncluded}h used
            </span>
          </div>
          <div style={{ height: "6px", borderRadius: "3px", backgroundColor: t.borderSubtle, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${usagePercent}%`,
                borderRadius: "3px",
                backgroundColor: usagePercent > 90 ? "#ef4444" : usagePercent > 70 ? "#f59e0b" : "#22c55e",
                transition: "width 500ms ease",
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px" }}>
            <span style={{ fontSize: "10px", color: t.textTertiary }}>Metered by the minute</span>
            <span style={{ fontSize: "10px", color: t.textTertiary }}>$0.12 / task hour overage</span>
          </div>
        </div>

        {/* Upgrade to Pro (only shown on Free plan) */}
        {isFree ? (
          <div
            style={{
              ...cardStyle(t),
              padding: "18px",
              border: "1px solid rgba(99, 102, 241, 0.3)",
              background: "linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(139, 92, 246, 0.04) 100%)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>Upgrade to Pro</div>
                <div style={{ fontSize: "11px", color: t.textSecondary, lineHeight: 1.5 }}>
                  Get 200 task hours per month, plus the ability to purchase additional hours in bulk. Currently limited to {currentPlan.taskHours} hours on the
                  Free plan.
                </div>
              </div>
              <button
                type="button"
                onClick={() => void navigate({ to: checkoutPath(organization, "team") })}
                style={{ ...primaryButtonStyle(t), whiteSpace: "nowrap", flexShrink: 0 }}
              >
                Upgrade — $25/mo
              </button>
            </div>
          </div>
        ) : null}

        {/* Buy more task hours (only shown on Pro plan) */}
        {!isFree ? (
          <SettingsContentSection
            title="Purchase Task Hours"
            description="Buy additional task hours in bulk. Hours are added to your current balance and don't expire."
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
              {taskHourPackages.map((pkg) => (
                <div
                  key={pkg.hours}
                  style={{
                    ...cardStyle(t),
                    padding: "14px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    cursor: "pointer",
                    transition: "border-color 150ms ease",
                  }}
                  onMouseEnter={(event) => {
                    (event.currentTarget as HTMLDivElement).style.borderColor = t.borderMedium;
                  }}
                  onMouseLeave={(event) => {
                    (event.currentTarget as HTMLDivElement).style.borderColor = t.borderSubtle;
                  }}
                >
                  <div style={{ fontSize: "16px", fontWeight: 700 }}>{pkg.hours}h</div>
                  <div style={{ fontSize: "11px", color: t.textSecondary }}>${((pkg.price / pkg.hours) * 60).toFixed(1)}¢/min</div>
                  <button type="button" style={{ ...secondaryButtonStyle(t), width: "100%", textAlign: "center", marginTop: "auto" }}>
                    ${pkg.price}
                  </button>
                </div>
              ))}
            </div>
          </SettingsContentSection>
        ) : null}

        {/* Payment method */}
        {hasStripeCustomer ? (
          <SettingsContentSection title="Payment" description={organization.billing.paymentMethodLabel || "No payment method on file."}>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                onClick={() =>
                  void (isMockFrontendClient ? navigate({ to: checkoutPath(organization, effectivePlanId) }) : client.openBillingPortal(organization.id))
                }
                style={secondaryButtonStyle(t)}
              >
                {isMockFrontendClient ? "Open hosted checkout mock" : "Manage in Stripe"}
              </button>
              {organization.billing.status === "scheduled_cancel" ? (
                <button type="button" onClick={() => void client.resumeSubscription(organization.id)} style={primaryButtonStyle(t)}>
                  Resume subscription
                </button>
              ) : (
                <button type="button" onClick={() => void client.cancelScheduledRenewal(organization.id)} style={subtleButtonStyle(t)}>
                  Cancel at period end
                </button>
              )}
            </div>
          </SettingsContentSection>
        ) : null}

        {/* Invoices */}
        <SettingsContentSection title="Invoices" description="Recent billing activity.">
          {organization.billing.invoices.length === 0 ? (
            <div style={{ color: t.textSecondary, fontSize: "11px" }}>No invoices yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {organization.billing.invoices.map((invoice) => (
                <div
                  key={invoice.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 80px 70px",
                    gap: "10px",
                    alignItems: "center",
                    padding: "8px 0",
                    borderTop: `1px solid ${t.borderSubtle}`,
                  }}
                >
                  <div>
                    <div style={{ fontSize: "12px", fontWeight: 500 }}>{invoice.label}</div>
                    <div style={{ fontSize: "10px", color: t.textSecondary }}>{invoice.issuedAt}</div>
                  </div>
                  <div style={{ fontSize: "12px", fontWeight: 500 }}>${invoice.amountUsd}</div>
                  <div>
                    <span
                      style={badgeStyle(
                        t,
                        invoice.status === "paid" ? "rgba(46, 160, 67, 0.16)" : "rgba(255, 193, 7, 0.18)",
                        invoice.status === "paid" ? "#b7f0c3" : "#ffe6a6",
                      )}
                    >
                      {invoice.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsContentSection>
      </div>
    </SettingsLayout>
  );
}

export function MockHostedCheckoutPage({ organization, planId }: { organization: FoundryOrganization; planId: FoundryBillingPlanId }) {
  const client = useMockAppClient();
  const navigate = useNavigate();
  const t = useFoundryTokens();
  const plan = planCatalog[planId]!;

  return (
    <SettingsLayout organization={organization} activeSection="billing">
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <div>
          <h1 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 600 }}>Checkout {plan.label}</h1>
          <p style={{ margin: 0, fontSize: "11px", color: t.textMuted }}>Complete payment to activate the {plan.label} plan.</p>
        </div>

        <SettingsContentSection title="Order summary" description={`${organization.settings.displayName} — ${plan.label} plan.`}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <CheckoutLine label="Plan" value={plan.label} />
            <CheckoutLine label="Price" value={plan.price} />
            <CheckoutLine label="Included seats" value={plan.seats} />
            <CheckoutLine label="Payment method" value="Visa ending in 4242" />
          </div>
        </SettingsContentSection>

        <SettingsContentSection title="Card details">
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={{ fontSize: "11px", fontWeight: 500, color: t.textMuted }}>Cardholder</span>
            <input value={organization.settings.displayName} readOnly style={inputStyle(t)} />
          </label>
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={{ fontSize: "11px", fontWeight: 500, color: t.textMuted }}>Card number</span>
            <input value="4242 4242 4242 4242" readOnly style={inputStyle(t)} />
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  await client.completeHostedCheckout(organization.id, planId);
                  if (isMockFrontendClient) {
                    await navigate({ to: billingPath(organization), replace: true });
                  }
                })();
              }}
              style={primaryButtonStyle(t)}
            >
              {isMockFrontendClient ? "Complete checkout" : "Continue to Stripe"}
            </button>
            <button type="button" onClick={() => void navigate({ to: billingPath(organization) })} style={subtleButtonStyle(t)}>
              Cancel
            </button>
          </div>
        </SettingsContentSection>
      </div>
    </SettingsLayout>
  );
}

function CheckoutLine({ label, value }: { label: string; value: string }) {
  const t = useFoundryTokens();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        padding: "7px 0",
        borderTop: `1px solid ${t.borderSubtle}`,
      }}
    >
      <div style={{ color: t.textSecondary, fontSize: "11px" }}>{label}</div>
      <div style={{ fontSize: "12px", fontWeight: 500 }}>{value}</div>
    </div>
  );
}

export function MockAccountSettingsPage() {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const user = activeMockUser(snapshot);
  const navigate = useNavigate();
  const t = useFoundryTokens();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");

  useEffect(() => {
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
  }, [user?.name, user?.email]);

  return (
    <div style={appSurfaceStyle(t)}>
      <DesktopDragRegion />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Left nav */}
        <div
          style={{
            width: "200px",
            flexShrink: 0,
            borderRight: `1px solid ${t.borderSubtle}`,
            padding: "44px 10px 16px",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            overflowY: "auto",
          }}
        >
          <button
            type="button"
            onClick={() => void navigate({ to: "/" })}
            style={{
              ...subtleButtonStyle(t),
              display: "flex",
              alignItems: "center",
              gap: "5px",
              marginBottom: "10px",
              fontSize: "11px",
            }}
          >
            <ArrowLeft size={12} />
            Back to organization
          </button>

          <div style={{ padding: "2px 10px 12px", display: "flex", flexDirection: "column", gap: "1px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600 }}>{user?.name ?? "User"}</span>
            <span style={{ fontSize: "10px", color: t.textMuted }}>{user?.email ?? ""}</span>
          </div>

          <SettingsNavItem icon={<Settings size={13} />} label="General" active onClick={() => {}} />
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "80px 36px 40px" }}>
          <div style={{ maxWidth: "560px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              <div>
                <h1 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 600 }}>Account</h1>
                <p style={{ margin: 0, fontSize: "11px", color: t.textMuted }}>Manage your personal account settings.</p>
              </div>

              <SettingsContentSection title="Profile">
                <label style={{ display: "grid", gap: "4px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 500, color: t.textMuted }}>Display name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle(t)} />
                </label>
                <label style={{ display: "grid", gap: "4px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 500, color: t.textMuted }}>Email</span>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle(t)} />
                </label>
                <label style={{ display: "grid", gap: "4px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 500, color: t.textMuted }}>GitHub</span>
                  <input value={`@${user?.githubLogin ?? ""}`} readOnly style={{ ...inputStyle(t), color: t.textMuted }} />
                </label>
                <div>
                  <button type="button" style={primaryButtonStyle(t)}>
                    Save changes
                  </button>
                </div>
              </SettingsContentSection>

              <SettingsContentSection title="Sessions" description="Manage your active sessions across devices.">
                <SettingsRow label="Current session" description="This device — signed in via GitHub OAuth." />
              </SettingsContentSection>

              <SettingsContentSection title="Sign out" description="Sign out of Foundry on this device.">
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      void (async () => {
                        await client.signOut();
                        await navigate({ to: "/signin" });
                      })();
                    }}
                    style={{ ...secondaryButtonStyle(t), display: "inline-flex", alignItems: "center", gap: "6px" }}
                  >
                    <LogOut size={12} />
                    Sign out
                  </button>
                </div>
              </SettingsContentSection>

              <SettingsContentSection title="Danger zone">
                <SettingsRow
                  label="Delete account"
                  description="Permanently delete your account and all data."
                  action={
                    <button
                      type="button"
                      style={{
                        ...secondaryButtonStyle(t),
                        borderColor: "rgba(255, 110, 110, 0.24)",
                        color: t.statusError,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      Delete
                    </button>
                  }
                />
              </SettingsContentSection>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { colorMode, setColorMode } = useColorMode();
  const t = useFoundryTokens();
  const isDark = colorMode === "dark";

  return (
    <SettingsContentSection title="Appearance" description="Customize how Foundry looks.">
      <SettingsRow
        label="Light mode"
        description={isDark ? "Currently using dark mode." : "Currently using light mode."}
        action={
          <button
            type="button"
            onClick={() => setColorMode(isDark ? "light" : "dark")}
            style={{
              position: "relative",
              width: "36px",
              height: "20px",
              borderRadius: "10px",
              border: "1px solid rgba(128, 128, 128, 0.3)",
              background: isDark ? t.borderDefault : t.accent,
              cursor: "pointer",
              padding: 0,
              transition: "background 0.2s",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: "2px",
                left: isDark ? "2px" : "16px",
                width: "14px",
                height: "14px",
                borderRadius: "50%",
                background: isDark ? t.textTertiary : "#ffffff",
                transition: "left 0.2s, background 0.2s",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {isDark ? <Moon size={8} /> : <Sun size={8} color={t.accent} />}
            </div>
          </button>
        }
      />
    </SettingsContentSection>
  );
}
