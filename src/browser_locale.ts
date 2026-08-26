export function canonicalSystemLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  try {
    return Intl.getCanonicalLocales(locale.replaceAll("_", "-"))[0];
  } catch {
    return undefined;
  }
}

export function detectSystemLocale(): string | undefined {
  try {
    return canonicalSystemLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return undefined;
  }
}
