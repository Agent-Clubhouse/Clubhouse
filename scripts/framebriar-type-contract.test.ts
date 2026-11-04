/** Compile the host's SDK contract: ordinary typecheck excludes *.test.ts files. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('typechecks the public Framebriar surface used by Clubhouse', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clubhouse-framebriar-types-'));
  try {
    const entry = path.join(dir, 'contract.ts');
    const sdk = path.resolve('src/main/vendor/framebriar/adapters/node/index.mjs').replaceAll('\\', '/');
    writeFileSync(entry, `
      import { createFramebriar, normalizeDiagnostics, otlpExporterOptions } from ${JSON.stringify(sdk)};
      import type { FramebriarAccessView, FramebriarReportDiagnostics, FramebriarSubmitAck } from ${JSON.stringify(sdk)};
      const options = {
        appId: 'clubhouse', dataDir: '/unused', telemetry: 'off' as const,
        safeStorage: { isEncryptionAvailable: () => true,
          encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
        fetchImpl: fetch,
        onAccessChange: (view: FramebriarAccessView) => { const expiry: string | null = view.expiresAt; const reason: 'invalid-deadline' | 'invalid-token' | 'wrong-game' | 'invalid-response' | null = view.noticeReason; void expiry; void reason; },
      };
      const fb = createFramebriar(options);
      // Electron 46 has only the async safeStorage API.
      createFramebriar({ ...options, safeStorage: { isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (s: string) => Buffer.from(s),
        decryptStringAsync: async (b: Buffer) => ({ result: b.toString(), shouldReEncrypt: false }) } });
      async function contract() {
        const connected: boolean = await fb.access.connect('fixture');
        const token: string | undefined = await fb.access.getToken();
        const result: { forgotten: boolean; revoked: boolean | null } = await fb.access.disconnect();
        const headers: Record<string, string> = await otlpExporterOptions(fb.access, 'logs').headers();
        const opened = await fb.feedback.open();
        const ref: string | null = opened.enrollmentRef;
        const prepared = await fb.feedback.prepare({ ...opened, notes: 'fixture', png: null });
        const preparedRef: string | null = prepared.enrollmentRef;
        const stop: () => void = fb.access.onEnrollmentChange(({ enrollmentRef }) => { const next: string | null = enrollmentRef; void next; });
        const current: { enrollmentRef: string | null; active: boolean } = await fb.access.enrollmentState();
        const { heldForEnrollment, heldBytes, releaseToken, clearToken } = fb.outbox.status();
        const released: { released: number; remaining: number; failed: number; code?: string } = await fb.outbox.releaseHeldReports({ releaseToken: releaseToken ?? '' });
        const cleared: { cleared: number; remaining: number; failed: number; code?: string } = await fb.outbox.clearHeldReports({ clearToken: clearToken ?? '' });
        // @ts-expect-error A release always carries the token the user confirmed.
        await fb.outbox.releaseHeldReports();
        // @ts-expect-error A clear always carries the token the user confirmed.
        await fb.outbox.clearHeldReports();
        const ack: FramebriarSubmitAck = await fb.feedback.submit(prepared, { includeDiagnostics: false });
        const retention: 'until-delivered-or-cleared' = fb.outbox.status().retention;
        const storage: { available: boolean; reason?: string } = await fb.store.probeAsync();
        const rejected: 'enrollment-response-rejected' | null = fb.access.status().notice === 'enrollment-response-rejected' ? 'enrollment-response-rejected' : null;
        void rejected;
        // @ts-expect-error Credentials are never present in the renderer-facing access view.
        fb.access.status().refreshToken;
        // @ts-expect-error The convenience factory does not forward low-level access options.
        createFramebriar({ ...options, accessTimeoutMs: 1 });
        // @ts-expect-error Enrollment is explicit and takes one invitation string.
        fb.access.connect({ invitation: 'fixture' });
        const carried: 'attached' | 'none' | 'left_out' | 'unavailable' | null = ack.reportDiagnostics;
        const diagnostics: FramebriarReportDiagnostics = normalizeDiagnostics({ v: 1, state: 'none' });
        await fb.feedback.prepare({ ...opened, png: null, diagnostics });
        // @ts-expect-error Clubhouse doesn't use the SDK's provider: reportDiagnosticsField is the only way to the field.
        createFramebriar({ ...options, diagnosticsProvider: () => [] });
        void [connected, token, result, headers, ack, retention, storage, carried, ref, preparedRef, stop, current, heldForEnrollment, heldBytes, released, cleared];
      }
      void contract;
    `);
    const program = ts.createProgram([entry], {
      noEmit: true, strict: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      types: ['node'], typeRoots: [path.resolve('node_modules/@types')],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
