import type { ScannedComponent } from '@/hooks/useComponentLibrary';

export interface PageTemplatePreset {
  id: string;
  name: string;
  /** Ordered library component names, top → bottom of the page. */
  components: string[];
}

// Names must match scanned library component names (preview-template/src/
// components/library). Unresolvable names are skipped at apply time.
export const PAGE_TEMPLATES: PageTemplatePreset[] = [
  { id: 'landing', name: 'Landing page', components: ['Header', 'Hero', 'Logos', 'Feature', 'Testimonials', 'CTA', 'Footer'] },
  { id: 'blog-home', name: 'Blog home', components: ['Header', 'Hero2', 'BlogSlot', 'Footer'] },
  { id: 'pricing', name: 'Pricing page', components: ['Header', 'Pricing', 'FAQ', 'CTA', 'Footer'] },
  { id: 'about-contact', name: 'About / Contact', components: ['Header', 'Team', 'Metrics', 'Testimonials2', 'CTA', 'Footer'] },
  { id: 'product-detail', name: 'Product detail', components: ['Header', 'Hero3', 'Feature2', 'Metrics2', 'Pricing2', 'FAQ', 'CTA', 'Footer'] },
  { id: 'cz-remeslnik', name: 'Řemeslník', components: ['CzNav', 'CzHeroRemeslo', 'CzSluzby', 'CzCenik', 'CzHodiny', 'CzReference', 'CzKontakt', 'CzLegalFooter'] },
  { id: 'cz-kadernictvi', name: 'Kadeřnictví', components: ['CzNav', 'CzHeroKadernictvi', 'CzSluzby', 'CzCenik', 'CzHodiny', 'CzReference', 'CzKontakt', 'CzLegalFooter'] },
  { id: 'cz-kavarna', name: 'Kavárna', components: ['CzNav', 'CzHeroKavarna', 'CzSluzby', 'CzCenik', 'CzHodiny', 'CzReference', 'CzKontakt', 'CzLegalFooter'] },
  { id: 'cz-penzion', name: 'Penzion', components: ['CzNav', 'CzHeroPenzion', 'CzSluzby', 'CzCenik', 'CzHodiny', 'CzReference', 'CzKontakt', 'CzLegalFooter'] },
  { id: 'cz-osvc', name: 'Konzultant', components: ['CzNav', 'CzHeroOsvc', 'CzSluzby', 'CzCenik', 'CzHodiny', 'CzReference', 'CzKontakt', 'CzLegalFooter'] },
  { id: 'cz-ochrana', name: 'Ochrana osobních údajů', components: ['CzNav', 'CzOchrana', 'CzLegalFooter'] },
];

/** Resolve a preset against the scanned library, preserving preset order. */
export function resolvePreset(
  preset: PageTemplatePreset,
  library: ScannedComponent[],
): { resolved: ScannedComponent[]; missing: string[] } {
  const byName = new Map(library.map((c) => [c.name, c]));
  const resolved: ScannedComponent[] = [];
  const missing: string[] = [];
  for (const name of preset.components) {
    const c = byName.get(name);
    if (c) resolved.push(c);
    else missing.push(name);
  }
  return { resolved, missing };
}
