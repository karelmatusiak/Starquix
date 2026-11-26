export interface KontaktConfig {
  webhook: string;
  email: string;
  turnstileSiteKey: string;
  turnstileSecret: string;
}

export function sanitizeKontakt(raw: Partial<KontaktConfig> | null | undefined): KontaktConfig;
export function handleKontakt(request: Request, config: Pick<KontaktConfig, 'webhook' | 'email' | 'turnstileSecret'>, fetchImpl?: typeof fetch): Promise<Response>;
export function contactWorkerSource(config: Partial<KontaktConfig> | null | undefined): string;
export function pagesFunctionSource(config: Partial<KontaktConfig> | null | undefined): string;
