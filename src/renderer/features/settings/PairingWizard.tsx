import { useState, useRef, useEffect } from 'react';
import { useAnnexClientStore, type DiscoveredService } from '../../stores/annexClientStore';
import { settingsInput } from './SettingsLayout';
import { Button } from '../../components/Button';

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
    <div className="py-2.5 border-t border-surface-0">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[13px] font-semibold text-ctp-text">
          {step === 'scanning' && 'Discovered services'}
          {step === 'pin-entry' && `Pair with ${selectedService?.alias || 'service'}`}
          {step === 'result' && 'Pairing result'}
        </div>
        <Button onClick={onClose} kind="quiet">
          Close
        </Button>
      </div>

      {step === 'scanning' && (
        <>
          {discoveredServices.length === 0 ? (
            <p className="text-xs text-ctp-overlay1 py-2">
              No services found on the network. Make sure the satellite has Annex turned on.
            </p>
          ) : (
            <ul className="mb-2">
              {discoveredServices.map((svc) => (
                <li key={svc.fingerprint} className="border-t border-surface-0 first:border-t-0">
                  <button
                    type="button"
                    onClick={() => handleSelectService(svc)}
                    className="w-full text-left flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-surface-0
                      transition-colors cursor-pointer group focus-ring"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-ctp-text truncate">{svc.alias}</div>
                      <div className="text-xs text-ctp-overlay1 font-mono truncate">{svc.host}</div>
                    </div>
                    <span className="text-xs text-ctp-overlay1 group-hover:text-ctp-text transition-colors">
                      Pair
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button onClick={handleRefresh} kind="ghost">
            Refresh
          </Button>
        </>
      )}

      {step === 'pin-entry' && (
        <div className="space-y-2">
          <p className="text-xs text-ctp-overlay1">
            Enter the PIN shown on <span className="text-ctp-text">{selectedService?.alias}</span>.
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
              aria-label="Pairing PIN"
              className={`${settingsInput} w-[140px] tracking-widest text-center font-mono`}
            />
            <Button
              onClick={handlePair}
              disabled={pairing || pin.length < 4}
              kind="primary"
            >
              {pairing ? 'Pairing…' : 'Pair'}
            </Button>
            <Button
              onClick={() => { setStep('scanning'); setSelectedService(null); }}
              kind="quiet"
            >
              Back
            </Button>
          </div>
        </div>
      )}

      {step === 'result' && (
        <div className="space-y-2">
          <div className={`text-xs ${resultSuccess ? 'text-ctp-success' : 'text-ctp-error'}`}>
            {resultMessage}
          </div>
          <div className="flex gap-2">
            {!resultSuccess && (
              <Button
                onClick={() => { setPin(''); setStep('pin-entry'); }}
                kind="ghost"
              >
                Try again
              </Button>
            )}
            <Button onClick={onClose} kind="ghost">
              {resultSuccess ? 'Done' : 'Cancel'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
