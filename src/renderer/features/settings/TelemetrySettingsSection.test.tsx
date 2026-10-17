import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TelemetrySettingsSection, WORKBOOK_DOCS_URL } from './TelemetrySettingsSection';
import type { TelemetryStatus } from '../../../shared/telemetry/settings-types';

function makeStatus(overrides: Partial<TelemetryStatus> = {}): TelemetryStatus {
  return {
    available: true,
    enabled: false,
    running: false,
    destination: 'azure',
    level: 'standard',
    sampleRate: 1,
    otlpTemporality: 'cumulative',
    azure: { configured: false },
    otlp: { configured: false, endpoint: '', headers: [] },
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
      .mockResolvedValueOnce({ ok: false, reason: 'needs_confirmation', needs: ['consent'], host: 'h.applicationinsights.azure.com', status: configured })
      .mockResolvedValueOnce({ ok: true, status: makeStatus({ ...configured, enabled: true, running: true, consentAccepted: true }) });
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByLabelText('Send telemetry to Application Insights'));
    const dialog = await screen.findByTestId('telemetry-confirm');
    expect(dialog).toHaveTextContent('It never sends');
    expect(dialog).toHaveTextContent('File paths, repository URLs and branch names');
    fireEvent.click(within(dialog).getByText('Continue'));
    await waitFor(() => expect(setEnabled).toHaveBeenLastCalledWith('azure', true, { consent: true }));
    expect(await screen.findByLabelText('Send telemetry to Application Insights')).toHaveAttribute('aria-pressed', 'true');
  });

  it('names the OTLP host before sending, with loopback wording for a local collector', async () => {
    const status = makeStatus({ consentAccepted: true, otlp: { configured: true, endpoint: 'http://localhost:4318', host: 'localhost:4318', headers: [] } });
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
    const status = makeStatus({ otlp: { configured: true, endpoint: 'https://otlp.example.com', host: 'otlp.example.com', headers: [{ name: 'x-api-key', last4: '1234' }] } });
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
    const api = mockApi(makeStatus({ enabled: true, running: true, consentAccepted: true, azure: { configured: true, ikeyLast4: 'abcd', host: 'h' } }));
    vi.spyOn(api, 'sendTest').mockResolvedValue({ ok: false, httpStatus: 400, latencyMs: 412, message: 'Rejected (HTTP 400). Check the instrumentation key in the connection string.' });
    render(<TelemetrySettingsSection />);
    fireEvent.click(within(await screen.findByRole('region', { name: 'Azure Application Insights' })).getByText('Send test event'));
    expect(await screen.findByTestId('telemetry-test-result-azure')).toHaveTextContent('Rejected (HTTP 400). Check the instrumentation key in the connection string. (HTTP 400, 412 ms)');
  });

  it('changes the level and shows the preview of what was sent', async () => {
    const status = makeStatus();
    const api = mockApi(status);
    const setLevel = vi.spyOn(api, 'setLevel').mockResolvedValue({ ok: true, status: { ...status, level: 'errors' } });
    vi.spyOn(api, 'getPreview').mockResolvedValue([{ signal: 'logs', name: 'clubhouse.telemetry.test', time: 1, attributes: { 'clubhouse.telemetry.destination': 'azure' } }]);
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByRole('radio', { name: /Errors only/ }));
    await waitFor(() => expect(setLevel).toHaveBeenCalledWith('errors'));
    expect(await screen.findByRole('radio', { name: /Errors only/ })).toHaveAttribute('aria-checked', 'true');
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

  it('warns that Clubhouse cannot control a non-local OTLP host when switching from App Insights', async () => {
    const status = makeStatus({ enabled: true, consentAccepted: true, otlp: { configured: true, endpoint: 'https://otlp.example.com', host: 'otlp.example.com', headers: [] } });
    const api = mockApi(status);
    vi.spyOn(api, 'setEnabled').mockResolvedValueOnce({ ok: false, reason: 'needs_confirmation', needs: ['switch_destination'], host: 'otlp.example.com', status });
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByLabelText('Send telemetry to OTLP'));
    const dialog = await screen.findByTestId('telemetry-confirm');
    expect(dialog).toHaveTextContent('instead of Application Insights');
    expect(dialog).toHaveTextContent("Clubhouse can't see or control what this service does with it.");
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
    vi.spyOn(api, 'setLevel').mockResolvedValue({ ok: true, status: { ...status, level: 'detailed' } });
    render(<TelemetrySettingsSection />);
    expect(await screen.findByLabelText('Send telemetry to OTLP')).toBeDisabled();
    expect(screen.getByLabelText('Send telemetry to OTLP')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://draft.example.com' } });
    fireEvent.click(screen.getByRole('radio', { name: /Detailed/ }));
    expect(await screen.findByRole('radio', { name: /Detailed/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Endpoint')).toHaveValue('https://draft.example.com');
  });

  it('confirms before clearing the offline queue', async () => {
    const status = makeStatus({ offlineItems: 4 });
    const api = mockApi(status);
    const clearOffline = vi.spyOn(api, 'clearOffline').mockResolvedValue({ ok: true, status: { ...status, offlineItems: 0 } });
    render(<TelemetrySettingsSection />);
    expect(await screen.findByText(/Offline queue: 4 items/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByText(/Offline queue/)).getByText('Clear'));
    expect(clearOffline).not.toHaveBeenCalled();
    expect(screen.getByText('Clear the offline queue?')).toBeInTheDocument();
    // The dialog renders in a portal after the page's own Clear link.
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' }).at(-1)!);
    await waitFor(() => expect(clearOffline).toHaveBeenCalled());
  });

  it('links App Insights users to the Workbook docs page in the browser', async () => {
    mockApi(makeStatus({ destination: 'azure' }));
    const open = vi.spyOn(window.clubhouse.app, 'openExternalUrl').mockResolvedValue(undefined as never);
    render(<TelemetrySettingsSection />);
    fireEvent.click(await screen.findByText('Get the Clubhouse Workbook'));
    expect(open).toHaveBeenCalledWith(WORKBOOK_DOCS_URL);
  });

  it('hides the Workbook link for OTLP', async () => {
    mockApi(makeStatus({ destination: 'otlp' }));
    render(<TelemetrySettingsSection />);
    await screen.findByText('Preview data');
    expect(screen.queryByText('Get the Clubhouse Workbook')).toBeNull();
  });
});
