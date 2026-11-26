import { useEffect, useState } from 'react';
import { Button, Field, Labeled, OperationNotice } from '@/components/ui';
import { Cancel, Form, Pane, Status, Window } from '@/components/DeployModal/publishParts';
import { loadKontakt, saveKontakt } from '@/services/kontaktProject';
import type { KontaktConfig } from '@/services/kontaktWorker.mjs';

const EMPTY: KontaktConfig = { webhook: '', email: '', turnstileSiteKey: '', turnstileSecret: '' };

export function ContactWindow({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [config, setConfig] = useState<KontaktConfig>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (key: keyof KontaktConfig) => (value: string) => { setConfig((current) => ({ ...current, [key]: value })); setSaved(false); };

  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    void loadKontakt().then((savedConfig) => { if (live && savedConfig) setConfig(savedConfig); });
    return () => { live = false; };
  }, [isOpen]);

  const save = async () => {
    setBusy(true); setFailure(false);
    try { setConfig(await saveKontakt(config)); setSaved(true); }
    catch { setFailure(true); }
    finally { setBusy(false); }
  };

  return (
    <Window isOpen={isOpen} onClose={onClose} title="Contact form">
      <Pane footer={
        <>
          <Status>{saved ? 'Saved. Publish again so the live site uses it.' : ''}</Status>
          <Cancel />
          <Button variant="primary" size="lg" label="Save into the site" loading={busy} onClick={() => { void save(); }} />
        </>
      }>
        <Form>
          <Labeled label="Webhook" caption="An https address that accepts JSON with name, email, message and to. That is how the message becomes an email.">
            <Field size="lg" value={config.webhook} aria-label="Webhook" placeholder="https://" onChange={set('webhook')} />
          </Labeled>
          <Labeled label="Email" caption="Who should receive it (the to field), and the address a visitor sees when sending is not set up.">
            <Field size="lg" value={config.email} aria-label="Email" placeholder="ahoj@example.cz" onChange={set('email')} />
          </Labeled>
          <Labeled label="Turnstile site key" caption="Optional. Leave both Turnstile fields empty to keep only the honeypot.">
            <Field size="lg" value={config.turnstileSiteKey} aria-label="Turnstile site key" onChange={set('turnstileSiteKey')} />
          </Labeled>
          <Labeled label="Turnstile secret" caption="Stored in the project and copied into the Worker on publish. It is not part of the public site.">
            <Field size="lg" type="password" value={config.turnstileSecret} aria-label="Turnstile secret" onChange={set('turnstileSecret')} />
          </Labeled>
          {failure && <OperationNotice title="The form settings could not be written. Open the project in the desktop app and try again." />}
          {!config.webhook && <OperationNotice title="Until a webhook is saved, the form tells the visitor to write to the email above." />}
        </Form>
      </Pane>
    </Window>
  );
}
