/** Portable Triplicate styling from generated build-time values, with no runtime brand import. */
import { brandValues } from './brand-values.ts';
/** The five contract states; draft and unknown/custom states retain a neutral open appearance. */
export declare const brandStatuses: readonly ['open', 'in_progress', 'blocked', 'closed', 'canceled'];
/** Explicit theme for offline formats whose renderers cannot evaluate CSS media queries. */
export type BrandTheme = keyof typeof brandValues;
/** Contract chip status after normalizing an extensible tracker state. */
export type BrandStatus = typeof brandStatuses[number];
/** Resolve an extensible tracker state without assigning decorative working-state tints. */
export declare function brandStatus(value: string): BrandStatus;
/** Resolve a token alias to a literal value for non-CSS renderers. */
export declare function brandValue(theme: BrandTheme, name: keyof typeof brandValues.light): string;
/** Declare only contract custom properties; standalone SVG/HTML adapts without external requests. */
export declare const brandCss: string;
/** Configure Mermaid with a local font stack and theme values, never a font URL. */
export declare function mermaidBrand(themeCss: string, theme?: BrandTheme): string;
/** Composite a translucent contract rule onto a sheet for engines accepting only literal hex colors. */
export declare function brandColor(theme: BrandTheme, name: keyof typeof brandValues.light): string;
