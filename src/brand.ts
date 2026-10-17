/** Portable Triplicate styling from generated build-time values, with no runtime brand import. */
import { brandValues } from './brand-values.ts';

/** The five contract states; draft and unknown/custom states retain a neutral open appearance. */
export const brandStatuses = ['open', 'in_progress', 'blocked', 'closed', 'canceled'] as const;
/** Explicit theme for offline formats whose renderers cannot evaluate CSS media queries. */
export type BrandTheme = keyof typeof brandValues;
/** Contract chip status after normalizing an extensible tracker state. */
export type BrandStatus = typeof brandStatuses[number];

/** Resolve an extensible tracker state without assigning decorative working-state tints. */
export function brandStatus(value: string): BrandStatus {
  return brandStatuses.find(status => status === value) ?? 'open';
}

/** Resolve a token alias to a literal value for non-CSS renderers. */
export function brandValue(theme: BrandTheme, name: keyof typeof brandValues.light): string {
  const value = brandValues[theme][name];
  const match = /^var\(--pm-([\w-]+)\)$/.exec(value);
  return match ? brandValue(theme, match[1] as keyof typeof brandValues.light) : value;
}

/** Declare only contract custom properties; standalone SVG/HTML adapts without external requests. */
export const brandCss = Object.entries(brandValues).map(([theme, values]) => {
  const body = Object.entries(values).map(([name, value]) => `--pm-${name}:${value}`).join(';') + `;color-scheme:${theme}`;
  return theme === 'light' ? `:root{${body}}` : `@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${body}}}:root[data-theme="dark"]{${body}}`;
}).join('\n');

/** Configure Mermaid with a local font stack and theme values, never a font URL. */
export function mermaidBrand(themeCss: string, theme: BrandTheme = 'light'): string {
  const values = brandValues[theme];
  const themeStyles = theme === 'dark' ? themeCss.replace(brandCss, `*{${Object.entries(values).map(([name, value]) => `--pm-${name}:${value}`).join(';')};color-scheme:dark}`) : themeCss;
  return '%%{init: ' + JSON.stringify({ theme: 'base', look: 'classic', fontFamily: values['font-mono'], themeVariables: {
    darkMode: theme === 'dark', background: values.paper, primaryColor: values.sheet,
    primaryTextColor: values.carbon, primaryBorderColor: values.carbon,
    lineColor: values.graphite, secondaryColor: values.sheet, tertiaryColor: values.paper,
    edgeLabelBackground: values.paper, textColor: values.carbon, fontFamily: values['font-mono'],
    taskBkgColor: values.sheet, taskBorderColor: values.carbon, taskTextColor: values.carbon,
    taskTextOutsideColor: values.carbon, activeTaskBkgColor: values['canary-wash'], activeTaskBorderColor: values.canary,
    doneTaskBkgColor: values.sheet, doneTaskBorderColor: values.stamp, critBkgColor: values.sheet,
    critBorderColor: values.graphite, todayLineColor: values.stamp, gridColor: values.rule,
    sectionBkgColor: values.paper, altSectionBkgColor: values.sheet,
  }, htmlLabels: true, themeCSS: themeStyles.replaceAll(':root', '*') }) + '}%%';
}

/** Composite a translucent contract rule onto a sheet for engines accepting only literal hex colors. */
export function brandColor(theme: BrandTheme, name: keyof typeof brandValues.light): string {
  const value = brandValue(theme, name);
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([.\d]+)\)$/.exec(value);
  if (!rgba) return value === 'transparent' ? brandValue(theme, 'sheet') : value;
  const sheet = brandValue(theme, 'sheet');
  const alpha = Number(rgba[4]);
  return '#' + [1, 2, 3].map((index) => Math.round(Number(rgba[index]) * alpha + parseInt(sheet.slice(1 + (index - 1) * 2, 3 + (index - 1) * 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}
