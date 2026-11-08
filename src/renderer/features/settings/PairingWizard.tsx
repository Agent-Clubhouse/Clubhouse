import { useState, useRef, useEffect } from 'react';
import { useAnnexClientStore, type DiscoveredService } from '../../stores/annexClientStore';
import { certificateCode } from '../../../shared/annex-certificate-code';
import { settingsInput } from './SettingsLayout';
import { Button } from '../../components/Button';

type WizardStep = 'choose' | 'probing' | 'verify' | 'pin-entry' | 'result';

/** The satellite to pair again, when the wizard opens from "Pair again". */
export interface RepairTarget {
  fingerprint: string;
  alias: string;
}

interface PairingWizardProps {
  onClose: () => void;
  repairTarget?: RepairTarget;
}

export function PairingWizard({ onClose, repairTarget }: PairingWizardProps) {
  const discoveredServices = useAnnexClientStore((s) => s.discoveredServices);
  const loadDiscovered = useAnnexClientStore((s) => s.loadDiscovered);
  const scan = useAnnexClientStore((s) => s.scan);
  const probeService = useAnnexClientStore((s) => s.probeService);
  const pairWith = useAnnexClientStore((s) => s.pairWith);
  const pairWithLink = useAnnexClientStore((s) => s.pairWithLink);

  const [step, setStep] = useState<WizardStep>('choose');
  const [link, setLink] = useState('');
  const [selectedService, setSelectedService] = useState<DiscoveredService | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pairing, setPairing] = useState(false);
  const [notice, setNotice] = useState('');
  const [resultMessage, setResultMessage] = useState('');
  const [resultSuccess, setResultSuccess] = useState(false);
  /** Where "Try again" goes after a failure. */
  const [retryStep, setRetryStep] = useState<'choose' | 'pin-entry'>('choose');

  const pinInputRef = useRef<HTMLInputElement>(null);
  const autoSelected = useRef(false);

  useEffect(() => {
    loadDiscovered();
    scan();
  }, [loadDiscovered, scan]);

  useEffect(() => {
    if (step === 'pin-entry' && pinInputRef.current) {
      pinInputRef.current.focus();
    }
  }, [step]);

  function showResult(success: boolean, message: string, retry: 'choose' | 'pin-entry') {
    setResultSuccess(success);
    setResultMessage(message);
    setRetryStep(retry);
    setStep('result');
  }

  async function handleSelectService(svc: DiscoveredService) {
    setSelectedService(svc);
    setPin('');
    setCode(null);
    setNotice('');
    setStep('probing');
    const probe = await probeService(svc.fingerprint);
    const probedCode = probe.success ? certificateCode(probe.certFingerprint) : null;
    if (!probedCode) {
      showResult(false, probe.error || `Couldn't read the certificate code from ${svc.alias}. Try again.`, 'choose');
      return;
    }
    setCode(probedCode);
    setStep('verify');
  }

  // "Pair again": read the satellite's certificate code straight away (main uses its last
  // announced address), then compare codes as usual. Pasting its link works too.
  useEffect(() => {
    if (!repairTarget || autoSelected.current || step !== 'choose') return;
    autoSelected.current = true;
    const match = discoveredServices.find((svc) => svc.fingerprint === repairTarget.fingerprint);
    void handleSelectService(match ?? ({ ...repairTarget, icon: '', color: '', host: '', mainPort: 0, pairingPort: 0, publicKey: '' } as DiscoveredService));
  }, [repairTarget, discoveredServices, step]);

  function handleCodesDiffer() {
    const alias = selectedService?.alias || 'that computer';
    setSelectedService(null);
    setCode(null);
    setNotice(`The codes didn't match, so ${alias} wasn't paired.`);
    setStep('choose');
  }

  async function handlePair() {
    if (!selectedService || pin.length < 4 || pairing) return;
    setPairing(true);
    const result = await pairWith(selectedService.fingerprint, pin);
    setPairing(false);
    if (result.success) {
      showResult(true, `Paired with ${result.alias || selectedService.alias}`, 'choose');
    } else {
      setPin('');
      showResult(false, result.error || 'Pairing failed. Try again.', 'pin-entry');
    }
  }

  async function handlePairWithLink() {
    const trimmed = link.trim();
    if (!trimmed || pairing) return;
    setPairing(true);
    const result = await pairWithLink(trimmed);
    setPairing(false);
    if (result.success) {
      setLink('');
      showResult(true, `Paired with ${result.alias || 'that computer'}`, 'choose');
    } else {
      showResult(false, result.error || 'Pairing failed. Try again.', 'choose');
    }
  }

  function backToChoose() {
    setSelectedService(null);
    setCode(null);
    setStep('choose');
  }

  let title = `Pair with ${selectedService?.alias || 'service'}`;
  if (step === 'choose') title = repairTarget ? `Pair again with ${repairTarget.alias}` : 'Pair with another computer';
  if (step === 'result') title = 'Pairing result';

  return (
    <div className="py-2.5 border-t border-surface-0" data-testid="pairing-wizard">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[13px] font-semibold text-ctp-text">{title}</div>
        <Button onClick={onClose} kind="quiet">
          Close
        </Button>
      </div>

      {step === 'choose' && (
        <div className="space-y-3">
          {notice && <p className="text-xs text-ctp-overlay1">{notice}</p>}

          <div className="space-y-1.5">
            <label htmlFor="annex-pairing-link" className="block text-[13px] text-ctp-text">
              Paste pairing link
            </label>
            <p className="text-xs text-ctp-overlay1">
              Copy it from Pairing link in Annex settings on the other computer.
            </p>
            <div className="flex gap-2">
              <input
                id="annex-pairing-link"
                type="text"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePairWithLink(); }}
                placeholder="clubhousego://pair?…"
                spellCheck={false}
                className={`${settingsInput} flex-1 min-w-0 font-mono`}
              />
              <Button
                onClick={handlePairWithLink}
                disabled={pairing || link.trim() === ''}
                kind="primary"
              >
                {pairing ? 'Pairing…' : 'Pair'}
              </Button>
            </div>
          </div>

          <div>
            <div className="text-[13px] text-ctp-text mb-1">Discovered on this network</div>
            {discoveredServices.length === 0 ? (
              <p className="text-xs text-ctp-overlay1 py-2">
                No computers found on the network yet. Check that Annex Network is on there.
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
            <Button onClick={() => scan()} kind="ghost">
              Refresh
            </Button>
          </div>
        </div>
      )}

      {step === 'probing' && (
        <p className="text-xs text-ctp-overlay1">
          Reading the certificate code from {selectedService?.alias}…
        </p>
      )}

      {step === 'verify' && (
        <div className="space-y-2">
          <p className="text-xs text-ctp-overlay1">
            Check that this matches the certificate code in Annex settings on{' '}
            <span className="text-ctp-text">{selectedService?.alias}</span>.
          </p>
          <div
            className="text-[13px] font-mono text-ctp-text tracking-widest select-all"
            data-testid="pairing-certificate-code"
          >
            {code}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => { setPin(''); setStep('pin-entry'); }} kind="primary">
              Codes match
            </Button>
            <Button onClick={handleCodesDiffer} kind="ghost">
              They don&apos;t match
            </Button>
          </div>
        </div>
      )}

      {step === 'pin-entry' && (
        <div className="space-y-2">
          <p className="text-xs text-ctp-overlay1">
            Enter the one-time code shown on <span className="text-ctp-text">{selectedService?.alias}</span>.
          </p>
          <div className="flex gap-2">
            <input
              ref={pinInputRef}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePair(); }}
              placeholder="000000"
              aria-label="One-time code"
              className={`${settingsInput} w-[140px] tracking-widest text-center font-mono`}
            />
            <Button
              onClick={handlePair}
              disabled={pairing || pin.length < 4}
              kind="primary"
            >
              {pairing ? 'Pairing…' : 'Pair'}
            </Button>
            <Button onClick={backToChoose} kind="quiet">
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
                onClick={() => (retryStep === 'pin-entry' ? setStep('pin-entry') : backToChoose())}
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
