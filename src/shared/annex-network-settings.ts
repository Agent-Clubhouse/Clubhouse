/** Bounded settings state only: never device identities, addresses or secrets. */
export interface AnnexNetworkSettingsState {
  server_enabled: boolean;
  client_enabled: boolean;
  network_enabled: boolean;
  loopback_only: boolean;
  effective_scope: 'loopback' | 'selected_interface' | 'network';
  discovery_enabled: boolean;
  process_restricted: boolean;
  expected_state: string;
}
