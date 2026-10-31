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
      import { createFramebriar, otlpExporterOptions } from ${JSON.stringify(sdk)};
      import type { FramebriarAccessView, FramebriarSubmitAck } from ${JSON.stringify(sdk)};
      const options = {
        appId: 'clubhouse', dataDir: '/unused', telemetry: 'off' as const,
        safeStorage: { isEncryptionAvailable: () => true,
          encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
        fetchImpl: fetch,
        onAccessChange: (view: FramebriarAccessView) => { const expiry: string | null = view.expiresAt; void expiry; },
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
        const prepared = await fb.feedback.prepare({ notes: 'fixture', png: null });
        const ack: FramebriarSubmitAck = await fb.feedback.submit(prepared, { includeDiagnostics: false });
        const retention: 'until-delivered-or-cleared' = fb.outbox.status().retention;
        const storage: { available: boolean; reason?: string } = await fb.store.probeAsync();
        // @ts-expect-error Credentials are never present in the renderer-facing access view.
        fb.access.status().refreshToken;
        // @ts-expect-error The convenience factory does not forward low-level access options.
        createFramebriar({ ...options, accessTimeoutMs: 1 });
        // @ts-expect-error Enrollment is explicit and takes one invitation string.
        fb.access.connect({ invitation: 'fixture' });
        void [connected, token, result, headers, ack, retention, storage];
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
