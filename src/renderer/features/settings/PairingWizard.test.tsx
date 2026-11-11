import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PairingWizard } from './PairingWizard';
import { useAnnexClientStore } from '../../stores/annexClientStore';

const CERT = 'ab12cd34ef567890'.padEnd(64, '0');
const CODE = 'AB12 CD34 EF56 7890';

const mockOnClose = vi.fn();
const mockPairWith = vi.fn();
const mockPairWithLink = vi.fn();
const mockPairWithEndpoint = vi.fn();
const mockProbeService = vi.fn();

const SERVICE = {
  fingerprint: 'abc123',
  alias: 'Test Machine',
  icon: '🖥',
  color: '#aaa',
  host: '192.168.1.42',
  mainPort: 9000,
  pairingPort: 9001,
  publicKey: 'pk-test',
};

function resetStores() {
  mockPairWith.mockResolvedValue({ success: true, alias: 'Test Machine' });
  mockPairWithLink.mockResolvedValue({ success: true, alias: 'Studio Mac' });
  mockPairWithEndpoint.mockResolvedValue({ success: true, alias: 'Studio Mac' });
  mockProbeService.mockResolvedValue({ success: true, certFingerprint: CERT });
  useAnnexClientStore.setState({
    discoveredServices: [SERVICE],
    loadDiscovered: vi.fn(),
    scan: vi.fn(),
    probeService: mockProbeService,
    pairWith: mockPairWith,
    pairWithLink: mockPairWithLink,
    pairWithEndpoint: mockPairWithEndpoint,
  });
}

async function selectAndConfirm() {
  fireEvent.click(screen.getByText('Test Machine'));
  await screen.findByTestId('pairing-certificate-code');
  fireEvent.click(screen.getByRole('button', { name: 'Codes match' }));
}

describe('PairingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders discovered services and the pairing link field', () => {
    render(<PairingWizard onClose={mockOnClose} />);
    expect(screen.getByText('Pair with another computer')).toBeInTheDocument();
    expect(screen.getByText('Test Machine')).toBeInTheDocument();
    expect(screen.getByLabelText('Paste pairing link')).toBeInTheDocument();
    expect(screen.getByText('Copy it from Pairing link in Annex settings on the other computer.')).toBeInTheDocument();
  });

  describe('discovered service', () => {
    it('reads the certificate and shows its code before asking for the PIN', async () => {
      render(<PairingWizard onClose={mockOnClose} />);
      fireEvent.click(screen.getByText('Test Machine'));
      expect(mockProbeService).toHaveBeenCalledWith('abc123');
      expect(await screen.findByTestId('pairing-certificate-code')).toHaveTextContent(CODE);
      expect(screen.getByText(/Check that this matches the certificate code in Annex settings on/)).toBeInTheDocument();
      expect(screen.queryByLabelText('One-time code')).not.toBeInTheDocument();
    });

    it('asks for the PIN once the codes match, then pairs', async () => {
      render(<PairingWizard onClose={mockOnClose} />);
      await selectAndConfirm();
      expect(screen.getByText(/Enter the one-time code/)).toBeInTheDocument();
      const pairBtn = screen.getByRole('button', { name: 'Pair' });
      expect(pairBtn).toHaveAttribute('data-kind', 'primary');

      fireEvent.change(screen.getByLabelText('One-time code'), { target: { value: '123456' } });
      fireEvent.click(pairBtn);
      expect(await screen.findByText('Paired with Test Machine')).toBeInTheDocument();
      expect(mockPairWith).toHaveBeenCalledWith('abc123', '123456');
    });

    it('goes back without sending the PIN when the codes differ', async () => {
      render(<PairingWizard onClose={mockOnClose} />);
      fireEvent.click(screen.getByText('Test Machine'));
      await screen.findByTestId('pairing-certificate-code');
      fireEvent.click(screen.getByRole('button', { name: "They don't match" }));

      expect(screen.getByText("The codes didn't match, so Test Machine wasn't paired.")).toBeInTheDocument();
      expect(screen.getByLabelText('Paste pairing link')).toBeInTheDocument();
      expect(screen.queryByLabelText('One-time code')).not.toBeInTheDocument();
      expect(mockPairWith).not.toHaveBeenCalled();
    });

    it('shows the probe error as given', async () => {
      mockProbeService.mockResolvedValueOnce({ success: false, error: 'Service not found. It may have gone offline.' });
      render(<PairingWizard onClose={mockOnClose} />);
      fireEvent.click(screen.getByText('Test Machine'));
      expect(await screen.findByText('Service not found. It may have gone offline.')).toBeInTheDocument();
      expect(mockPairWith).not.toHaveBeenCalled();
    });

    it('shows the pairing error as given and lets the person retry the PIN', async () => {
      mockPairWith.mockResolvedValueOnce({ success: false, error: 'That PIN has expired. Use the one shown now.' });
      render(<PairingWizard onClose={mockOnClose} />);
      await selectAndConfirm();
      fireEvent.change(screen.getByLabelText('One-time code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
      expect(await screen.findByText('That PIN has expired. Use the one shown now.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByLabelText('One-time code')).toHaveValue('');
    });
  });

  describe('pairing link', () => {
    it('pairs with the pasted link', async () => {
      render(<PairingWizard onClose={mockOnClose} />);
      const pairBtn = screen.getByRole('button', { name: 'Pair' });
      expect(pairBtn).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Paste pairing link'), { target: { value: '  clubhousego://pair?v=1  ' } });
      fireEvent.click(pairBtn);
      expect(await screen.findByText('Paired with Studio Mac')).toBeInTheDocument();
      expect(mockPairWithLink).toHaveBeenCalledWith('clubhousego://pair?v=1', undefined);
      expect(mockProbeService).not.toHaveBeenCalled();
    });

    it('passes the optional forwarded TLS endpoint without changing the pairing link', async () => {
      render(<PairingWizard onClose={mockOnClose} />);
      fireEvent.change(screen.getByLabelText('Paste pairing link'), { target: { value: 'clubhousego://pair?v=1' } });
      fireEvent.change(screen.getByLabelText('Address override (optional)'), { target: { value: ' 127.0.0.1:7443 ' } });
      fireEvent.keyDown(screen.getByLabelText('Address override (optional)'), { key: 'Enter' });
      expect(await screen.findByText('Paired with Studio Mac')).toBeInTheDocument();
      expect(mockPairWithLink).toHaveBeenCalledWith('clubhousego://pair?v=1', '127.0.0.1:7443');
    });

    it('shows the error as given', async () => {
      mockPairWithLink.mockResolvedValueOnce({ success: false, error: "That isn't a Clubhouse pairing link." });
      render(<PairingWizard onClose={mockOnClose} />);
      fireEvent.change(screen.getByLabelText('Paste pairing link'), { target: { value: 'nope' } });
      fireEvent.keyDown(screen.getByLabelText('Paste pairing link'), { key: 'Enter' });
      expect(await screen.findByText("That isn't a Clubhouse pairing link.")).toBeInTheDocument();
    });
  });

  describe('pair again', () => {
    it('starts comparing codes at once, though the satellite is not in the discovered list', async () => {
      // A satellite that needs pairing again is a known satellite, never a discovered service.
      useAnnexClientStore.setState({ discoveredServices: [] });
      render(<PairingWizard onClose={mockOnClose} repairTarget={{ fingerprint: 'abc123', alias: 'Test Machine' }} />);
      await waitFor(() => expect(mockProbeService).toHaveBeenCalledWith('abc123'));
      expect(await screen.findByTestId('pairing-certificate-code')).toHaveTextContent(CODE);
    });

    it('pairs without a link only after all manual fields are filled', async () => {
      render(<PairingWizard onClose={mockOnClose} />);
      fireEvent.click(screen.getByRole('button', { name: 'Pair without a link' }));
      expect(screen.getByRole('button', { name: 'Pair manually' })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Address and port'), { target: { value: ' 127.0.0.1:7443 ' } });
      fireEvent.change(screen.getByLabelText('Certificate fingerprint'), { target: { value: ` ${CERT} ` } });
      fireEvent.change(screen.getByLabelText('One-time code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByRole('button', { name: 'Pair manually' }));
      expect(await screen.findByText('Paired with Studio Mac')).toBeInTheDocument();
      expect(mockPairWithEndpoint).toHaveBeenCalledWith('127.0.0.1:7443', '123456', CERT);
      expect(mockPairWithLink).not.toHaveBeenCalled();
    });

    it('shows manual pairing errors and clears the PIN before retrying', async () => {
      mockPairWithEndpoint.mockResolvedValueOnce({ success: false, error: 'The certificate does not match. The code was not sent.' });
      render(<PairingWizard onClose={mockOnClose} />);
      fireEvent.click(screen.getByRole('button', { name: 'Pair without a link' }));
      fireEvent.change(screen.getByLabelText('Address and port'), { target: { value: 'localhost:7443' } });
      fireEvent.change(screen.getByLabelText('Certificate fingerprint'), { target: { value: CERT } });
      fireEvent.change(screen.getByLabelText('One-time code'), { target: { value: '123456' } });
      fireEvent.keyDown(screen.getByLabelText('One-time code'), { key: 'Enter' });
      expect(await screen.findByText('The certificate does not match. The code was not sent.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByLabelText('One-time code')).toHaveValue('');
      expect(screen.getByLabelText('Certificate fingerprint')).toHaveValue(CERT);
    });

    it('does not pick it again after the codes differ', async () => {
      render(<PairingWizard onClose={mockOnClose} repairTarget={{ fingerprint: 'abc123', alias: 'Test Machine' }} />);
      await screen.findByTestId('pairing-certificate-code');
      fireEvent.click(screen.getByRole('button', { name: "They don't match" }));
      expect(screen.getByLabelText('Paste pairing link')).toBeInTheDocument();
      expect(mockProbeService).toHaveBeenCalledTimes(1);
    });
  });
});
