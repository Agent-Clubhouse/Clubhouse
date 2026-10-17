import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TelemetrySettingsSection, WORKBOOK_DOCS_URL } from './TelemetrySettingsSection';
import type { TelemetryDestinationStatus, TelemetryStatus } from '../../../shared/telemetry/settings-types';

function destStatus(id: 'azure' | 'otlp', overrides: Partial<TelemetryDestinationStatus> = {}): TelemetryDestinationStatus {
  return {
    id,
    kind: id,
    label: id === 'azure' ? 'Azure Application Insights' : 'OpenTelemetry (OTLP)',
    enabled: false,
    level: 'standard',
    preset: 'all',
    configured: false,
    active: false,
    health: { state: 'off' },
    offlineQueue: id === 'azure',
    ...overrides,
  };
}

function makeStatus(
  overrides: Partial<TelemetryStatus> = {},
  dests: { azure?: Partial<TelemetryDestinationStatus>; otlp?: Partial<TelemetryDestinationStatus> } = {},
): TelemetryStatus {
  return {
    available: true,
    enabled: false,
    running: false,
    destinations: [destStatus('azure', dests.azure), destStatus('otlp', dests.otlp)],
    sampleRate: 1,
    azure: { configured: false },
    otlp: { configured: false, endpoint: '', headers: [], temporality: 'cumulative' },
    consentAccepted: false,
    secureStorage: 'available',
    weakStorageAccepted: false,
    offlineItems: 0,
    ...overrides,
  };
}

function mockApi(status: TelemetryStatus) {
  const api = window.clubhouse.telemetrySettings;
  vi.spyOn(api, 'getStatus').mockResolvedValue(status);
  return api;
}

describe('TelemetrySettingsSection', () => {
  it('renders nothing while the experimental flag is off', async () => {
    mockApi(makeStatus({ available: false }));
    const { container } = render(<TelemetrySettingsSection />);
    await waitFor(() => expect(window.clubhouse.telemetrySettings.getStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('leads with the App Insights panel and keeps OTLP in its own panel', async () => {
    mockApi(makeStatus());
    render(<TelemetrySettingsSection />);
    const azure = await screen.findByRole('region', { name: 'Azure Application Insights' });
    expect(within(azure).getByLabelText('Connection string')).toBeInTheDocument();
    expect(within(azure).queryByLabelText('Endpoint')).toBeNull();
    const other = screen.getByRole('region', { name: 'Other destinations' });
    expect(within(other).getByLabelText('Endpoint')).toBeInTheDocument();
    expect(screen.getByText('Protocol: HTTP/JSON')).toBeInTheDocument();
  });

  it('saves a connection string and then only shows its masked form', async () => {
    const api = mockApi(makeStatus());
    vi.spyOn(api, 'saveAzure').mockResolvedValue({
      ok: true,
      status: makeStatus({ azure: { configured: true, ikeyLast4: 'abcd', host: 'westus2-1.in.applicationinsights.azure.com' } }),
    });
    render(<TelemetrySettingsSection />);
    const input = await screen.findByLabelText('Connection string');
    fireEvent.change(input, { target: { value: 'InstrumentationKey=x;IngestionEndpoint=https://y' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Azure Application Insights' })).getByText('Save'));
    expect(await screen.findByTestId('telemetry-cs-masked')).toHaveTextContent('IKey …abcd · westus2-1.in.applicationinsights.azure.com');
    expect(api.saveAzure).toHaveBeenCalledWith('InstrumentationKey=x;IngestionEndpoint=https://y', {});
    expect(screen.queryByDisplayValue(/InstrumentationKey/)).toBeNull();
  });

  it('shows validation errors from main', async () => {
    const api = mockApi(makeStatus());
    vi.spyOn(api, 'saveAzure').mockResolvedValue({
      ok: false, reason: 'bare_instrumentation_key', message: 'Paste the full connection string.', status: makeStatus(),
    });
    render(<TelemetrySettingsSection />);
    fireEvent.change(await screen.findByLabelText('Connection string'), { target: { value: 'abc' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Azure Application Insights' })).getByText('Save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Paste the full connection string.');
  });

  it('asks for consent, then retries the enable with the acknowledgement', async () => {
    const configured = makeStatus({ azure: { configured: true, ikeyLast4: 'abcd', host: 'h.applicationinsights.azure.com' } });
    const api = mockApi(configured);
    const setEnabled = vi.spyOn(api, 'setEnabled')
      .mockResolvedValueOnce({ ok: false, reason: 'needs_confirmation', needs: ['consent'], host: 'h.applicationinsights.azure.com', hosts: ['h.applicationinsights.azure.com'], status: configured })
      .mockResolvedValueOnce({
        ok: true,
        status: makeStatus({ azure: configured.azure, enabled: true, running: true, consentAccepted: true }, { azure: { enabled: true, active: true, configured: true } }),
      });
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByLabelText('Send telemetry to Application Insights'));
    const dialog = await screen.findByTestId('telemetry-confirm');
    expect(dialog).toHaveTextContent('never sends');
    expect(within(screen.getByTestId('telemetry-confirm-hosts')).getByText('h.applicationinsights.azure.com')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('File paths, repository URLs and branch names');
    fireEvent.click(within(dialog).getByText('Continue'));
    await waitFor(() => expect(setEnabled).toHaveBeenLastCalledWith('azure', true, { consent: true, host: 'h.applicationinsights.azure.com' }));
    expect(await screen.findByLabelText('Send telemetry to Application Insights')).toHaveAttribute('aria-pressed', 'true');
  });

  it('names the OTLP host before sending, with loopback wording for a local collector', async () => {
    const status = makeStatus({ consentAccepted: true, otlp: { configured: true, endpoint: 'http://localhost:4318', host: 'localhost:4318', headers: [], temporality: 'cumulative' } });
    const api = mockApi(status);
    const setEnabled = vi.spyOn(api, 'setEnabled')
      .mockResolvedValueOnce({ ok: false, reason: 'needs_confirmation', needs: ['destination'], host: 'localhost:4318', status })
      .mockResolvedValueOnce({ ok: true, status });
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByLabelText('Send telemetry to OTLP'));
    const dialog = await screen.findByTestId('telemetry-confirm');
    expect(dialog).toHaveTextContent('Telemetry will be sent to a collector on this computer (localhost:4318).');
    fireEvent.click(within(dialog).getByText('Continue'));
    await waitFor(() => expect(setEnabled).toHaveBeenLastCalledWith('otlp', true, { host: 'localhost:4318' }));
  });

  it('keeps stored header values masked and only sends values the user typed', async () => {
    const status = makeStatus({ otlp: { configured: true, endpoint: 'https://otlp.example.com', host: 'otlp.example.com', headers: [{ name: 'x-api-key', last4: '1234' }], temporality: 'cumulative' } });
    const api = mockApi(status);
    const saveOtlp = vi.spyOn(api, 'saveOtlp').mockResolvedValue({ ok: true, status });
    render(<TelemetrySettingsSection />);
    const value = await screen.findByLabelText('Header 1 value');
    expect(value).toHaveAttribute('placeholder', '••••1234');
    expect(value).toHaveValue('');
    fireEvent.click(within(screen.getByRole('region', { name: 'Other destinations' })).getByText('Save'));
    await waitFor(() => expect(saveOtlp).toHaveBeenCalledWith(
      { endpoint: 'https://otlp.example.com', headers: [{ name: 'x-api-key', value: undefined }] }, {},
    ));
  });

  it('reports the test event result with status and latency', async () => {
    const api = mockApi(makeStatus(
      { enabled: true, running: true, consentAccepted: true, azure: { configured: true, ikeyLast4: 'abcd', host: 'h' } },
      { azure: { enabled: true, active: true, configured: true } },
    ));
    const sendTest = vi.spyOn(api, 'sendTest').mockResolvedValue({ ok: false, httpStatus: 400, latencyMs: 412, message: 'Rejected (HTTP 400). Check the instrumentation key in the connection string.' });
    render(<TelemetrySettingsSection />);
    // OTLP isn't exporting, so only App Insights can be tested.
    expect(within(await screen.findByRole('region', { name: 'Other destinations' })).getByText('Send test event')).toBeDisabled();
    fireEvent.click(within(screen.getByRole('region', { name: 'Azure Application Insights' })).getByText('Send test event'));
    await waitFor(() => expect(sendTest).toHaveBeenCalledWith('azure'));
    expect(await screen.findByTestId('telemetry-test-result-azure')).toHaveTextContent('Rejected (HTTP 400). Check the instrumentation key in the connection string. (HTTP 400, 412 ms)');
  });

  it('sets each destination its own level and preset, and shows the preview of what was sent', async () => {
    const status = makeStatus();
    const api = mockApi(status);
    const setFilter = vi.spyOn(api, 'setFilter')
      .mockResolvedValueOnce({ ok: true, status: makeStatus({}, { azure: { level: 'errors' } }) })
      .mockResolvedValueOnce({ ok: true, status: makeStatus({}, { azure: { level: 'errors' }, otlp: { preset: 'user_activity' } }) });
    vi.spyOn(api, 'getPreview').mockResolvedValue([{ signal: 'logs', destination: 'azure', name: 'clubhouse.telemetry.test', time: 1, attributes: { 'clubhouse.telemetry.destination': 'azure' } }]);
    render(<TelemetrySettingsSection />);
    fireEvent.change(await screen.findByLabelText('Azure Application Insights level'), { target: { value: 'errors' } });
    await waitFor(() => expect(setFilter).toHaveBeenCalledWith('azure', 'errors', 'all'));
    expect(await screen.findByLabelText('Azure Application Insights level')).toHaveValue('errors');
    fireEvent.change(screen.getByLabelText('OpenTelemetry (OTLP) filter'), { target: { value: 'user_activity' } });
    await waitFor(() => expect(setFilter).toHaveBeenLastCalledWith('otlp', 'standard', 'user_activity'));
    expect(await screen.findByLabelText('OpenTelemetry (OTLP) filter')).toHaveValue('user_activity');
    expect(screen.getByLabelText('Azure Application Insights level')).toHaveValue('errors');
    fireEvent.click(screen.getByText('Preview data'));
    expect(await screen.findByTestId('telemetry-preview')).toHaveTextContent('clubhouse.telemetry.test');
  });

  it('confirms before resetting the install ID', async () => {
    const status = makeStatus({ installId: '11111111-1111-4111-8111-111111111111' });
    const api = mockApi(status);
    const resetId = vi.spyOn(api, 'resetId').mockResolvedValue({ ok: true, status: { ...status, installId: '22222222-2222-4222-8222-222222222222' } });
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByText('Reset telemetry ID'));
    expect(resetId).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(resetId).toHaveBeenCalled());
    expect(await screen.findByText('22222222-2222-4222-8222-222222222222')).toBeInTheDocument();
  });

  it('lists every host that will receive data in the consent dialog', async () => {
    const status = makeStatus({ otlp: { configured: true, endpoint: 'https://otlp.example.com', host: 'otlp.example.com', headers: [], temporality: 'cumulative' } });
    const api = mockApi(status);
    vi.spyOn(api, 'setEnabled').mockResolvedValueOnce({
      ok: false, reason: 'needs_confirmation', needs: ['consent', 'destination'], host: 'otlp.example.com',
      hosts: ['westus2-1.in.applicationinsights.azure.com', 'otlp.example.com'], status,
    });
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByLabelText('Send telemetry to OTLP'));
    const hosts = await screen.findByTestId('telemetry-confirm-hosts');
    expect(within(hosts).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'westus2-1.in.applicationinsights.azure.com', 'otlp.example.com',
    ]);
    expect(screen.getByTestId('telemetry-confirm')).toHaveTextContent("Clubhouse can't see or control what these services do with it.");
  });

  it('confirms the Framebriar host the dialog listed, and only that one', async () => {
    const status = makeStatus({ azure: { configured: true, ikeyLast4: 'abcd', host: 'h.applicationinsights.azure.com' } });
    const api = mockApi(status);
    const setEnabled = vi.spyOn(api, 'setEnabled')
      .mockResolvedValueOnce({
        ok: false, reason: 'needs_confirmation', needs: ['consent', 'destination'], host: 'h.applicationinsights.azure.com',
        hosts: ['h.applicationinsights.azure.com', 'framebriar.example.net'], followHost: 'framebriar.example.net', status,
      })
      .mockResolvedValueOnce({ ok: true, status });
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByLabelText('Send telemetry to Application Insights'));
    const dialog = await screen.findByTestId('telemetry-confirm');
    fireEvent.click(within(dialog).getByText('Continue'));
    await waitFor(() => expect(setEnabled).toHaveBeenLastCalledWith('azure', true, {
      consent: true, host: 'h.applicationinsights.azure.com', followHost: 'framebriar.example.net',
    }));
  });

  it('shows each destination its own health, and both can be on at once', async () => {
    mockApi(makeStatus({ enabled: true, running: true, consentAccepted: true }, {
      azure: { enabled: true, active: true, configured: true, health: { state: 'ok', lastSuccessAt: Date.now() } },
      otlp: { enabled: true, active: true, configured: true, health: { state: 'failing', message: 'Connection refused. Is the collector running?' } },
    }));
    render(<TelemetrySettingsSection />);
    expect(await screen.findByTestId('telemetry-health-azure')).toHaveTextContent('Sending · last export');
    expect(screen.getByTestId('telemetry-health-otlp')).toHaveTextContent('Failing: Connection refused. Is the collector running?');
    expect(screen.getByLabelText('Send telemetry to Application Insights')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Send telemetry to OTLP')).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears the typed connection string after a weak-storage confirmed save', async () => {
    const api = mockApi(makeStatus({ secureStorage: 'weak' }));
    const saved = makeStatus({ secureStorage: 'weak', weakStorageAccepted: true, azure: { configured: true, ikeyLast4: 'abcd', host: 'h' } });
    const saveAzure = vi.spyOn(api, 'saveAzure')
      .mockResolvedValueOnce({ ok: false, reason: 'needs_confirmation', needs: ['weak_storage'], status: makeStatus({ secureStorage: 'weak' }) })
      .mockResolvedValueOnce({ ok: true, status: saved });
    render(<TelemetrySettingsSection />);
    fireEvent.change(await screen.findByLabelText('Connection string'), { target: { value: 'InstrumentationKey=x;IngestionEndpoint=https://y' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Azure Application Insights' })).getByText('Save'));
    const dialog = await screen.findByTestId('telemetry-confirm');
    expect(dialog).toHaveTextContent('no keyring');
    fireEvent.click(within(dialog).getByText('Continue'));
    await waitFor(() => expect(saveAzure).toHaveBeenLastCalledWith('InstrumentationKey=x;IngestionEndpoint=https://y', { weakStorage: true }));
    expect(await screen.findByTestId('telemetry-cs-masked')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Replace'));
    expect(screen.getByLabelText('Connection string')).toHaveValue('');
  });

  it('keeps unsaved OTLP edits when another setting changes, and marks unusable toggles disabled', async () => {
    const status = makeStatus();
    const api = mockApi(status);
    vi.spyOn(api, 'setFilter').mockResolvedValue({ ok: true, status: makeStatus({}, { azure: { level: 'detailed' } }) });
    render(<TelemetrySettingsSection />);
    expect(await screen.findByLabelText('Send telemetry to OTLP')).toBeDisabled();
    expect(screen.getByLabelText('Send telemetry to OTLP')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://draft.example.com' } });
    fireEvent.change(screen.getByLabelText('Azure Application Insights level'), { target: { value: 'detailed' } });
    expect(await screen.findByLabelText('Azure Application Insights level')).toHaveValue('detailed');
    expect(screen.getByLabelText('Endpoint')).toHaveValue('https://draft.example.com');
  });

  it('shows a start error under the destination that failed, and keeps OTLP temporality in its panel', async () => {
    const api = mockApi(makeStatus({ enabled: true, running: true, consentAccepted: true }, {
      azure: { enabled: true, active: true, configured: true, health: { state: 'ok', lastSuccessAt: Date.now() } },
      otlp: { enabled: true, active: false, configured: true, health: { state: 'error', message: 'The endpoint is not a valid URL.' } },
    }));
    const setAdvanced = vi.spyOn(api, 'setAdvanced').mockResolvedValue({ ok: true, status: makeStatus() });
    render(<TelemetrySettingsSection />);
    const otlp = await screen.findByRole('region', { name: 'Other destinations' });
    expect(within(otlp).getByTestId('telemetry-health-otlp')).toHaveTextContent('Not sending: The endpoint is not a valid URL.');
    expect(within(screen.getByRole('region', { name: 'Azure Application Insights' })).queryByText(/not a valid URL/)).toBeNull();
    fireEvent.click(within(otlp).getByLabelText('Delta'));
    await waitFor(() => expect(setAdvanced).toHaveBeenCalledWith({ otlpTemporality: 'delta' }));
  });

  it('confirms before clearing the offline queue', async () => {
    const status = makeStatus({ offlineItems: 4 });
    const api = mockApi(status);
    const clearOffline = vi.spyOn(api, 'clearOffline').mockResolvedValue({ ok: true, status: { ...status, offlineItems: 0 } });
    render(<TelemetrySettingsSection />);
    expect(await screen.findByText(/Offline queue \(Application Insights only\): 4 items/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByText(/Offline queue/)).getByText('Clear'));
    expect(clearOffline).not.toHaveBeenCalled();
    expect(screen.getByText('Clear the offline queue?')).toBeInTheDocument();
    // The dialog renders in a portal after the page's own Clear link.
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' }).at(-1)!);
    await waitFor(() => expect(clearOffline).toHaveBeenCalled());
  });

  it('links App Insights users to the Workbook docs page in the browser', async () => {
    mockApi(makeStatus({}, { azure: { enabled: true } }));
    const open = vi.spyOn(window.clubhouse.app, 'openExternalUrl').mockResolvedValue(undefined as never);
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByText('Get the Clubhouse Workbook'));
    expect(open).toHaveBeenCalledWith(WORKBOOK_DOCS_URL);
  });

  it('hides the Workbook link when only OTLP is on', async () => {
    mockApi(makeStatus({}, { otlp: { enabled: true } }));
    render(<TelemetrySettingsSection />);
    await screen.findByText('Preview data');
    expect(screen.queryByText('Get the Clubhouse Workbook')).toBeNull();
  });

  describe('Clubhouse developer (Framebriar) panel', () => {
    const fb = (o: Partial<TelemetryDestinationStatus> = {}): TelemetryDestinationStatus => ({
      id: 'framebriar', kind: 'framebriar', label: 'Clubhouse developer (Framebriar)', enabled: false, level: 'standard',
      preset: 'user_activity', configured: false, active: false, health: { state: 'off' }, offlineQueue: false, ...o,
    });

    it('needs Feedback connected before it can be switched on', async () => {
      mockApi(makeStatus({ destinations: [destStatus('azure'), destStatus('otlp'), fb()] }));
      render(<TelemetrySettingsSection />);
      const panel = await screen.findByRole('region', { name: 'Clubhouse developer (Framebriar)' });
      expect(within(panel).getByTestId('telemetry-framebriar-needs-feedback').textContent).toBe('Connect Feedback in Settings, Feedback first.');
      expect(within(panel).getByLabelText('Send telemetry to the Clubhouse developer')).toBeDisabled();
      expect(within(panel).getByLabelText('Clubhouse developer (Framebriar) filter')).toHaveValue('user_activity');
    });

    it('turns it off through its own destination id', async () => {
      const api = mockApi(makeStatus({ destinations: [destStatus('azure'), destStatus('otlp'), fb({ configured: true, enabled: true, active: true, host: 'framebriar.example.net' })] }));
      const setEnabled = vi.spyOn(api, 'setEnabled').mockResolvedValue({ ok: true, status: makeStatus() } as never);
      render(<TelemetrySettingsSection />);
      const panel = await screen.findByRole('region', { name: 'Clubhouse developer (Framebriar)' });
      fireEvent.click(within(panel).getByLabelText('Send telemetry to the Clubhouse developer'));
      await waitFor(() => expect(setEnabled).toHaveBeenCalledWith('framebriar', false, {}));
      expect(within(panel).getByText('Send test event')).not.toBeDisabled();
    });

    it('is absent when the status has no Framebriar destination', async () => {
      mockApi(makeStatus());
      render(<TelemetrySettingsSection />);
      await screen.findByRole('region', { name: 'Azure Application Insights' });
      expect(screen.queryByTestId('telemetry-panel-framebriar')).toBeNull();
    });
  });
});

