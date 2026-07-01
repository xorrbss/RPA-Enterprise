import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type {
  ScimGroupRoleMappingImportBody,
  ScimProviderCreateBody,
  ScimProviderItem,
  ScimProviderUpdateBody,
} from "../src/api/types";
import { fakeClient } from "./fake-client";

function renderApp(client: ApiClient): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function scimProvider(overrides: Partial<ScimProviderItem> = {}): ScimProviderItem {
  return {
    provider_id: "provider-okta",
    provider_key: "okta",
    display_name: "Okta",
    status: "active",
    inbound_schema_ref: "scim-principal@1",
    auth_mode: "signed_request_v1",
    signature_secret_ref: "secret://tenant/scim/okta/signing",
    secret_rotation_policy: "manual",
    rotation_due_at: null,
    rotation_status: "manual",
    clock_skew_seconds: 300,
    created_by: "admin",
    updated_by: null,
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
    last_secret_rotated_at: null,
    last_secret_rotated_by: null,
    decommissioned_at: null,
    decommissioned_by: null,
    decommission_reason: null,
    ...overrides,
  };
}

describe("SCIM provider admin panel", () => {
  test("admin manages provider SecretRef and group mappings without secret values", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    const createScimProvider = vi.fn(async (body: ScimProviderCreateBody) =>
      scimProvider({
        provider_id: "provider-new",
        provider_key: body.provider_key,
        display_name: body.display_name,
        signature_secret_ref: body.signature_secret_ref,
        secret_rotation_policy: body.secret_rotation_policy ?? "periodic_90d",
        created_by: "u",
      }),
    );
    const createScimGroupRoleMapping = vi.fn(async (_providerKey: string, body: { external_group: string; role: string; description?: string | null }) => ({
      mapping_id: "mapping-new",
      provider_key: "okta",
      external_group: body.external_group,
      role: body.role as "viewer",
      status: "active" as const,
      description: body.description ?? null,
      created_by: "u",
      updated_by: null,
      created_at: "2026-06-29T00:00:00.000Z",
      updated_at: "2026-06-29T00:00:00.000Z",
    }));
    renderApp(fakeClient({
      listScimProviders: async () => ({
        items: [scimProvider({
          last_secret_rotated_at: "2026-06-29T01:00:00.000Z",
          last_secret_rotated_by: "admin",
        })],
        next_cursor: null,
      }),
      listScimGroupRoleMappings: async () => ({
        items: [{
          mapping_id: "mapping-okta",
          provider_key: "okta",
          external_group: "grp-rpa-viewers",
          role: "viewer",
          status: "active",
          description: null,
          created_by: "admin",
          updated_by: null,
          created_at: "2026-06-29T00:00:00.000Z",
          updated_at: "2026-06-29T00:00:00.000Z",
        }],
        next_cursor: null,
      }),
      createScimProvider,
      createScimGroupRoleMapping,
    }));
    location.hash = "#security?section=access";

    const okta = await screen.findByText("Okta");
    const panel = okta.closest("section");
    expect(panel).not.toBeNull();
    const scoped = within(panel as HTMLElement);
    expect(await scoped.findByText("secret://tenant/scim/okta/signing")).toBeInTheDocument();
    expect(await scoped.findByText("SecretRef rotation")).toBeInTheDocument();
    expect(screen.queryByText("actual-signing-secret")).toBeNull();

    fireEvent.change(scoped.getByPlaceholderText("okta"), { target: { value: "entra" } });
    fireEvent.change(scoped.getByPlaceholderText("Okta"), { target: { value: "Microsoft Entra" } });
    fireEvent.change(scoped.getByPlaceholderText("secret://tenant/scim/okta/signing"), {
      target: { value: "secret://tenant/scim/entra/signing" },
    });
    const rotationPolicy = scoped.getByLabelText("Rotation policy for new SCIM provider") as HTMLSelectElement;
    expect(rotationPolicy.value).toBe("periodic_90d");
    fireEvent.click(scoped.getByTitle("Create SCIM provider"));
    await waitFor(() => expect(createScimProvider).toHaveBeenCalledTimes(1));
    expect(createScimProvider.mock.calls[0]?.[0]).toMatchObject({
      provider_key: "entra",
      signature_secret_ref: "secret://tenant/scim/entra/signing",
      secret_rotation_policy: "periodic_90d",
    });

    fireEvent.change(scoped.getByPlaceholderText("grp-rpa-operators"), { target: { value: "entra-rpa-operators" } });
    fireEvent.change(scoped.getByDisplayValue("viewer"), { target: { value: "operator" } });
    fireEvent.click(scoped.getByRole("button", { name: "Create SCIM group mapping" }));
    await waitFor(() => expect(createScimGroupRoleMapping).toHaveBeenCalledTimes(1));
    expect(createScimGroupRoleMapping.mock.calls[0]?.[0]).toBe("okta");
    expect(createScimGroupRoleMapping.mock.calls[0]?.[1]).toMatchObject({
      external_group: "entra-rpa-operators",
      role: "operator",
    });
  });

  test("admin rotates provider signing SecretRef via updateScimProvider", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    const updateScimProvider = vi.fn(async (providerKey: string, body: ScimProviderUpdateBody) =>
      scimProvider({
        provider_key: providerKey,
        signature_secret_ref: body.signature_secret_ref ?? "secret://tenant/scim/okta/signing",
        last_secret_rotated_at: body.signature_secret_ref !== undefined ? "2026-06-29T02:00:00.000Z" : null,
        last_secret_rotated_by: body.signature_secret_ref !== undefined ? "admin" : null,
      }),
    );
    renderApp(fakeClient({
      listScimProviders: async () => ({ items: [scimProvider()], next_cursor: null }),
      listScimGroupRoleMappings: async () => ({ items: [], next_cursor: null }),
      updateScimProvider,
    }));
    location.hash = "#security?section=access";

    await screen.findByText("Okta");
    fireEvent.click(await screen.findByRole("button", { name: "Rotate SecretRef for okta" }));
    fireEvent.change(screen.getByLabelText("New SecretRef for okta"), {
      target: { value: "secret://tenant/scim/okta/signing-v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm SecretRef rotation for okta" }));

    await waitFor(() => expect(updateScimProvider).toHaveBeenCalledTimes(1));
    expect(updateScimProvider.mock.calls[0]?.[0]).toBe("okta");
    expect(updateScimProvider.mock.calls[0]?.[1]).toEqual({
      signature_secret_ref: "secret://tenant/scim/okta/signing-v2",
    });
  });

  test("provider evidence shows SecretRef rotation policy status and due metadata", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    renderApp(fakeClient({
      listScimProviders: async () => ({
        items: [scimProvider({
          secret_rotation_policy: "periodic_30d",
          rotation_due_at: "2026-07-29T00:00:00.000Z",
          rotation_status: "due_soon",
        })],
        next_cursor: null,
      }),
      listScimGroupRoleMappings: async () => ({ items: [], next_cursor: null }),
    }));
    location.hash = "#security?section=access";

    const okta = await screen.findByText("Okta");
    const panel = okta.closest("section");
    expect(panel).not.toBeNull();
    const scoped = within(panel as HTMLElement);
    expect(await scoped.findByText("rotation due_soon")).toBeInTheDocument();
    expect(scoped.getByText(/policy: periodic_30d \/ due:/)).toBeInTheDocument();
  });

  test("admin updates provider rotation policy without rotating SecretRef", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    const updateScimProvider = vi.fn(async (providerKey: string, body: ScimProviderUpdateBody) =>
      scimProvider({
        provider_key: providerKey,
        secret_rotation_policy: body.secret_rotation_policy ?? "manual",
        rotation_due_at: body.secret_rotation_policy === "manual" ? null : "2026-08-28T00:00:00.000Z",
        rotation_status: body.secret_rotation_policy === "manual" ? "manual" : "current",
      }),
    );
    renderApp(fakeClient({
      listScimProviders: async () => ({ items: [scimProvider()], next_cursor: null }),
      listScimGroupRoleMappings: async () => ({ items: [], next_cursor: null }),
      updateScimProvider,
    }));
    location.hash = "#security?section=access";

    await screen.findByText("Okta");
    fireEvent.change(await screen.findByLabelText("Secret rotation policy for okta"), {
      target: { value: "periodic_60d" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update rotation policy for okta" }));

    await waitFor(() => expect(updateScimProvider).toHaveBeenCalledTimes(1));
    expect(updateScimProvider.mock.calls[0]?.[0]).toBe("okta");
    expect(updateScimProvider.mock.calls[0]?.[1]).toEqual({
      secret_rotation_policy: "periodic_60d",
    });
  });

  test("admin decommissions provider with reason", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    const decommissionScimProvider = vi.fn(async (providerKey: string, body: { reason: string }) => ({
      provider: scimProvider({
        provider_key: providerKey,
        status: "disabled",
        decommissioned_at: "2026-06-29T03:00:00.000Z",
        decommissioned_by: "admin",
        decommission_reason: body.reason,
      }),
      disabled_mappings: 1,
      revoked_assignments: 2,
    }));
    renderApp(fakeClient({
      listScimProviders: async () => ({ items: [scimProvider()], next_cursor: null }),
      listScimGroupRoleMappings: async () => ({ items: [], next_cursor: null }),
      decommissionScimProvider,
    }));
    location.hash = "#security?section=access";

    await screen.findByText("Okta");
    fireEvent.click(await screen.findByRole("button", { name: "Decommission okta" }));
    fireEvent.change(screen.getByLabelText("Decommission reason for okta"), {
      target: { value: "Retired IdP tenant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm decommission for okta" }));

    await waitFor(() => expect(decommissionScimProvider).toHaveBeenCalledTimes(1));
    expect(decommissionScimProvider.mock.calls[0]?.[0]).toBe("okta");
    expect(decommissionScimProvider.mock.calls[0]?.[1]).toEqual({ reason: "Retired IdP tenant" });
  });

  test("admin imports CSV group-role mappings in upsert mode", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    const importScimGroupRoleMappings = vi.fn(async (providerKey: string, body: ScimGroupRoleMappingImportBody) => ({
      provider_key: providerKey,
      mode: body.mode,
      imported: 2,
      updated: 0,
      unchanged: 0,
      disabled: 0,
      items: [],
    }));
    renderApp(fakeClient({
      listScimProviders: async () => ({ items: [scimProvider()], next_cursor: null }),
      listScimGroupRoleMappings: async () => ({ items: [], next_cursor: null }),
      importScimGroupRoleMappings,
    }));
    location.hash = "#security?section=access";

    const input = await screen.findByLabelText("Mapping import CSV for okta");
    fireEvent.change(input, {
      target: { value: "external_group,role,description\ngrp-rpa-operators,operator,Ops group\ngrp-rpa-admins,admin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import SCIM group mappings for okta" }));

    await waitFor(() => expect(importScimGroupRoleMappings).toHaveBeenCalledTimes(1));
    expect(importScimGroupRoleMappings.mock.calls[0]?.[0]).toBe("okta");
    expect(importScimGroupRoleMappings.mock.calls[0]?.[1]).toEqual({
      mode: "upsert_only",
      mappings: [
        { external_group: "grp-rpa-operators", role: "operator", description: "Ops group" },
        { external_group: "grp-rpa-admins", role: "admin", description: null },
      ],
    });
    expect(await screen.findByText("imported 2")).toBeInTheDocument();
  });

  test("admin selects replace_active for mapping reconciliation", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    const importScimGroupRoleMappings = vi.fn(async (providerKey: string, body: ScimGroupRoleMappingImportBody) => ({
      provider_key: providerKey,
      mode: body.mode,
      imported: 1,
      updated: 0,
      unchanged: 0,
      disabled: 3,
      items: [],
    }));
    renderApp(fakeClient({
      listScimProviders: async () => ({ items: [scimProvider()], next_cursor: null }),
      listScimGroupRoleMappings: async () => ({ items: [], next_cursor: null }),
      importScimGroupRoleMappings,
    }));
    location.hash = "#security?section=access";

    fireEvent.change(await screen.findByLabelText("Mapping import mode for okta"), { target: { value: "replace_active" } });
    fireEvent.change(screen.getByLabelText("Mapping import CSV for okta"), { target: { value: "grp-rpa-reviewers,reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Import SCIM group mappings for okta" }));

    await waitFor(() => expect(importScimGroupRoleMappings).toHaveBeenCalledTimes(1));
    expect(importScimGroupRoleMappings.mock.calls[0]?.[1].mode).toBe("replace_active");
  });

  test("mapping import rejects invalid CSV before API call", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    const importScimGroupRoleMappings = vi.fn();
    renderApp(fakeClient({
      listScimProviders: async () => ({ items: [scimProvider()], next_cursor: null }),
      listScimGroupRoleMappings: async () => ({ items: [], next_cursor: null }),
      importScimGroupRoleMappings,
    }));
    location.hash = "#security?section=access";

    const input = await screen.findByLabelText("Mapping import CSV for okta");
    fireEvent.change(input, { target: { value: "grp-rpa-admins,owner" } });
    fireEvent.click(screen.getByRole("button", { name: "Import SCIM group mappings for okta" }));
    expect(await screen.findByText("Line 1: invalid role owner")).toBeInTheDocument();
    expect(importScimGroupRoleMappings).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "grp-rpa-admins" } });
    fireEvent.click(screen.getByRole("button", { name: "Import SCIM group mappings for okta" }));
    expect(await screen.findByText("Line 1: expected external_group,role,description")).toBeInTheDocument();
    expect(importScimGroupRoleMappings).not.toHaveBeenCalled();
  });

  test("decommissioned provider mapping mutations are locked", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    location.hash = "";
    renderApp(fakeClient({
      listScimProviders: async () => ({
        items: [scimProvider({
          status: "disabled",
          decommissioned_at: "2026-06-29T03:00:00.000Z",
          decommissioned_by: "admin",
          decommission_reason: "Retired IdP tenant",
        })],
        next_cursor: null,
      }),
      listScimGroupRoleMappings: async () => ({
        items: [{
          mapping_id: "mapping-okta",
          provider_key: "okta",
          external_group: "grp-rpa-viewers",
          role: "viewer",
          status: "active",
          description: null,
          created_by: "admin",
          updated_by: null,
          created_at: "2026-06-29T00:00:00.000Z",
          updated_at: "2026-06-29T00:00:00.000Z",
        }],
        next_cursor: null,
      }),
    }));
    location.hash = "#security?section=access";

    expect(await screen.findByText("Provider decommission")).toBeInTheDocument();
    expect(await screen.findByText("rotation decommissioned")).toBeInTheDocument();
    expect(await screen.findByText("mapping mutations locked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status locked for okta" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Rotate SecretRef for okta" })).toBeNull();
    expect(screen.getByPlaceholderText("grp-rpa-operators")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create SCIM group mapping" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import SCIM group mappings for okta" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mapping status locked for grp-rpa-viewers" })).toBeDisabled();
  });

  test("operator cannot see SCIM provider management", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    location.hash = "";
    renderApp(fakeClient());
    location.hash = "#security?section=access";
    await waitFor(() => expect(screen.queryByTitle("Create SCIM provider")).toBeNull());
  });
});
