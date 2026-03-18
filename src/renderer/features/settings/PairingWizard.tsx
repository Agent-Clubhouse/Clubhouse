import { useState, useRef, useEffect } from 'react';
import { useAnnexClientStore, type DiscoveredService } from '../../stores/annexClientStore';

type WizardStep = 'scanning' | 'pin-entry' | 'result';

interface PairingWizardProps {
  onClose: () => void;
}

export function PairingWizard({ onClose }: PairingWizardProps) {
  const discoveredServices = useAnnexClientStore((s) => s.discoveredServices);
  const loadDiscovered = useAnnexClientStore((s) => s.loadDiscovered);
  const scan = useAnnexClientStore((s) => s.scan);
  const pairWith = useAnnexClientStore((s) => s.pairWith);

  const [step, setStep] = useState<WizardStep>('scanning');
  const [selectedService, setSelectedService] = useState<DiscoveredService | null>(null);
  const [pin, setPin] = useState('');
  const [pairing, setPairing] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [resultSuccess, setResultSuccess] = useState(false);

  const pinInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadDiscovered();
    scan();
  }, [loadDiscovered, scan]);

  useEffect(() => {
    if (step === 'pin-entry' && pinInputRef.current) {
      pinInputRef.current.focus();
    }
  }, [step]);

  function handleSelectService(svc: DiscoveredService) {
    setSelectedService(svc);
    setPin('');
    setStep('pin-entry');
  }

  function handleRefresh() {
    scan();
  }

  async function handlePair() {
    if (!selectedService || pin.length < 4) return;
    setPairing(true);
    const result = await pairWith(selectedService.fingerprint, pin);
    setPairing(false);
    setResultSuccess(result.success);
    setResultMessage(result.success ? `Paired with ${selectedService.alias}` : result.error || 'Pairing failed');
    setStep('result');
  }

  function handlePinKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handlePair();
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-surface-1 bg-surface-0/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium text-ctp-text">
          {step === 'scanning' && 'Discovered Services'}
          {step === 'pin-entry' && `Pair with ${selectedService?.alias || 'Service'}`}
          {step === 'result' && 'Pairing Result'}
        </div>
        <button
          onClick={onClose}
          className="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
        >
          Close
        </button>
      </div>

      {step === 'scanning' && (
        <>
          {discoveredServices.length === 0 ? (
            <div className="text-xs text-ctp-subtext0 py-4 text-center">
              No services found on the network. Make sure the satellite has Annex enabled.
            </div>
          ) : (
            <ul className="space-y-2 mb-3">
              {discoveredServices.map((svc) => (
                <li key={svc.fingerprint}>
                  <button
                    onClick={() => handleSelectService(svc)}
                    className="w-full text-left px-3 py-2 rounded bg-surface-1 hover:bg-surface-2
                      transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-ctp-text font-medium">{svc.alias}</div>
                        <div className="text-xs text-ctp-subtext0">{svc.host}</div>
                      </div>
                      <span className="text-xs text-ctp-subtext0 group-hover:text-ctp-text transition-colors">
                        Pair
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={handleRefresh}
            className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
              transition-colors cursor-pointer text-ctp-subtext1 hover:text-ctp-text"
          >
            Refresh
          </button>
        </>
      )}

      {step === 'pin-entry' && (
        <div className="space-y-3">
          <p className="text-xs text-ctp-subtext0">
            Enter the PIN shown on <span className="font-medium text-ctp-text">{selectedService?.alias}</span>:
          </p>
          <div className="flex gap-2">
            <input
              ref={pinInputRef}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={handlePinKeyDown}
              placeholder="000000"
              className="flex-1 px-3 py-2 text-sm rounded bg-surface-1 border border-surface-2
                text-ctp-text placeholder-ctp-overlay0 outline-none focus:border-ctp-blue
                tracking-widest text-center font-mono"
            />
            <button
              onClick={handlePair}
              disabled={pairing || pin.length < 4}
              className="px-4 py-2 text-xs rounded bg-ctp-blue text-ctp-base font-medium
                hover:bg-ctp-blue/80 transition-colors cursor-pointer
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pairing ? 'Pairing...' : 'Pair'}
            </button>
          </div>
          <button
            onClick={() => { setStep('scanning'); setSelectedService(null); }}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
          >
            Back
          </button>
        </div>
      )}

      {step === 'result' && (
        <div className="space-y-3">
          <div className={`text-sm ${resultSuccess ? 'text-ctp-green' : 'text-ctp-red'}`}>
            {resultMessage}
          </div>
          <div className="flex gap-2">
            {!resultSuccess && (
              <button
                onClick={() => { setPin(''); setStep('pin-entry'); }}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
                  transition-colors cursor-pointer text-ctp-subtext1 hover:text-ctp-text"
              >
                Try Again
              </button>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
                transition-colors cursor-pointer text-ctp-subtext1 hover:text-ctp-text"
            >
              {resultSuccess ? 'Done' : 'Cancel'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
