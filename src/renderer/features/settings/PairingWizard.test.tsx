import { render, screen, fireEvent } from '@testing-library/react';
import { PairingWizard } from './PairingWizard';
import { useAnnexClientStore } from '../../stores/annexClientStore';

const mockOnClose = vi.fn();
const mockPairWith = vi.fn().mockResolvedValue({ success: true });

function resetStores() {
  useAnnexClientStore.setState({
    discoveredServices: [
      {
        fingerprint: 'abc123',
        alias: 'Test Machine',
        icon: '🖥',
        color: '#aaa',
        host: '192.168.1.42',
        mainPort: 9000,
        pairingPort: 9001,
        publicKey: 'pk-test',
      },
    ],
    loadDiscovered: vi.fn(),
    scan: vi.fn(),
    pairWith: mockPairWith,
  });
}

describe('PairingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders discovered services', () => {
    render(<PairingWizard onClose={mockOnClose} />);
    expect(screen.getByText('Test Machine')).toBeInTheDocument();
  });

  it('shows pin entry step when a service is selected', () => {
    render(<PairingWizard onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Test Machine'));
    expect(screen.getByText(/Enter the PIN/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair' })).toBeInTheDocument();
  });

  it('Pair button is the primary action', () => {
    render(<PairingWizard onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Test Machine'));
    const pairBtn = screen.getByRole('button', { name: 'Pair' });
    expect(pairBtn).toHaveAttribute('data-kind', 'primary');
  });
});
