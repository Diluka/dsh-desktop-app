import { launchDetachedHidden } from "./hidden_process.ts";

export interface BrowserLocaleLaunchPlan {
  readonly executable: string;
  readonly args: string[];
  readonly locale: string;
}

export interface BrowserLocaleBootstrapResult {
  readonly locale?: string;
  readonly relaunched: boolean;
  readonly error?: unknown;
}

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

export function commandLineSwitchValue(
  args: readonly string[],
  name: "--lang" | "--accept-lang",
): string | undefined {
  const prefix = `${name}=`;
  const argument = args.find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length).match(/^[^\s]+/u)?.[0];
  return value || undefined;
}

export function resolveBrowserLocale(
  args: readonly string[],
  systemLocale: string | undefined,
): string | undefined {
  return canonicalSystemLocale(commandLineSwitchValue(args, "--lang") ?? systemLocale);
}

export function browserLocaleArguments(locale: string): string[] {
  const canonical = canonicalSystemLocale(locale);
  if (!canonical) return [];
  const primary = canonical.split("-")[0];
  const acceptLanguages = [...new Set([canonical, primary])].join(",");
  return [`--lang=${canonical}`, `--accept-lang=${acceptLanguages}`];
}

export function createBrowserLocaleLaunchPlan(
  args: readonly string[],
  systemLocale: string | undefined,
  desktop: boolean,
  hmr: boolean,
  executable: string,
): BrowserLocaleLaunchPlan | undefined {
  const explicitLocale = commandLineSwitchValue(args, "--lang");
  const locale = resolveBrowserLocale(args, systemLocale);
  const hasAcceptLanguage = commandLineSwitchValue(args, "--accept-lang") !== undefined;
  if (
    !desktop || hmr || !locale || hasAcceptLanguage ||
    (Deno.build.os !== "windows" && Deno.build.os !== "darwin")
  ) {
    return undefined;
  }

  const localeArgs = browserLocaleArguments(locale);
  if (explicitLocale) localeArgs.shift();
  return {
    executable,
    args: [...args, ...localeArgs],
    locale,
  };
}

export async function prepareSystemBrowserLocale(): Promise<BrowserLocaleBootstrapResult> {
  const systemLocale = detectSystemLocale();
  const locale = resolveBrowserLocale(Deno.args, systemLocale);
  const plan = createBrowserLocaleLaunchPlan(
    Deno.args,
    systemLocale,
    Deno.env.get("DENO_SERVE_ADDRESS") !== undefined,
    Deno.env.get("DENO_DESKTOP_HMR") !== undefined,
    Deno.execPath(),
  );
  if (!plan) return { locale, relaunched: false };

  try {
    await launchDetachedHidden(plan.executable, plan.args);
    return { locale: plan.locale, relaunched: true };
  } catch (error) {
    return { locale: plan.locale, relaunched: false, error };
  }
}
