import { useState } from 'react';
import { Button, Field, Labeled, OperationNotice, Row } from '@/components/ui';
import { Cancel, Form, Pane, Status, Window } from '@/components/DeployModal/publishParts';
import { fetchAres, type AresFailure, type Firma } from '@/services/ares';
import { saveFirma } from '@/services/aresProject';

const FAIL: Record<AresFailure | 'save', string> = {
  invalid: 'IČO has a wrong checksum.',
  'not-found': 'ARES does not list this IČO.',
  offline: 'ARES is not reachable. Check the connection and try again.',
  save: 'The company was loaded, but the project files could not be written. Open the project in the desktop app and try again.',
};

export function AresWindow({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [ico, setIco] = useState('');
  const [firma, setFirma] = useState<Firma | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AresFailure | 'save' | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setBusy(true); setFailure(null); setSaved(false);
    try { setFirma(await fetchAres(ico)); }
    catch (error) { setFirma(null); setFailure((error as { code?: AresFailure }).code ?? 'offline'); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!firma) return;
    setBusy(true); setFailure(null);
    try { await saveFirma(firma); setSaved(true); }
    catch { setFailure('save'); }
    finally { setBusy(false); }
  };

  return (
    <Window isOpen={isOpen} onClose={onClose} title="Company from ARES">
      <Pane footer={
        <>
          <Status>{saved ? 'Company details are in the footer.' : ''}</Status>
          <Cancel />
          <Button variant="primary" size="lg" loading={busy}
            label={firma ? 'Save into the site' : 'Load from ARES'}
            onClick={() => { void (firma ? save() : load()); }} />
        </>
      }>
        <Form>
          <Labeled label="IČO" caption="Eight digits. We check the checksum, then ask ARES.">
            <Field size="lg" value={ico} onChange={(value) => { setIco(value); setFirma(null); setSaved(false); }} placeholder="27082440" aria-label="IČO" />
          </Labeled>
          {firma && (
            <>
              <Row hover={false} size="sm" title="Name" rightText={firma.nazev} />
              <Row hover={false} size="sm" title="Address" rightText={firma.adresa} />
              <Row hover={false} size="sm" title="DIČ" rightText={firma.dic || '—'} />
              <Row hover={false} size="sm" title="Show the cookie bar" right={[{ type: 'toggle', value: firma.cookies, onChange: (on: boolean) => setFirma({ ...firma, cookies: on }) }]} />
            </>
          )}
          {failure && <OperationNotice title={FAIL[failure]} />}
          {saved && <OperationNotice title="The contact form is at functions/api/kontakt.js. It sends mail only after you set CONTACT_WEBHOOK on Cloudflare Pages." />}
        </Form>
      </Pane>
    </Window>
  );
}
