import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { SettingsField } from './SettingsLayout';

interface Props {
  /** The `clubhousego://pair` link from AnnexStatus.pairingUrl. */
  url: string;
  hosts: string[];
  port: number;
}

/** An SVG data URL, so it renders without a canvas and scales crisply. */
async function qrDataUrl(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
    color: { dark: '#000000', light: '#ffffff' },
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * "Pair a phone": the pairing link as a QR code for Clubhouse Go or the iPhone
 * Camera. Black on white whatever the theme, since cameras need the contrast.
 */
export function AnnexPairingQr({ url, hosts, port }: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    qrDataUrl(url).then(
      (dataUrl) => { if (!cancelled) setSrc(dataUrl); },
      () => { if (!cancelled) setSrc(null); },
    );
    return () => { cancelled = true; };
  }, [url]);

  return (
    <SettingsField
      label="Pair a phone"
      testId="annex-pairing-qr"
      help={(
        <span>
          Scan with Clubhouse Go, or with the iPhone Camera. The code includes this session&apos;s PIN; regenerate the PIN to invalidate it.
          {hosts.length > 0 && (
            <>
              <br />
              <span className="font-mono select-all text-ctp-text">{hosts[0]} · port {port}</span>
            </>
          )}
        </span>
      )}
    >
      <div className="p-2 rounded-lg border border-surface-1 bg-ctp-mantle">
        {src ? (
          <img
            src={src}
            alt="QR code for pairing Clubhouse Go with this machine"
            width={200}
            height={200}
            className="block w-[200px] h-[200px] rounded bg-white"
          />
        ) : (
          <div className="w-[200px] h-[200px] rounded bg-white" aria-hidden="true" />
        )}
      </div>
    </SettingsField>
  );
}
