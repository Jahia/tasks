/**
 * i18n for this module's board, against the app shell's own i18next instance.
 *
 * <h3>Why a bridge instead of react-i18next</h3>
 * react-i18next's own no-instance fallback is unusable as a degradation path: in the version the
 * shell ships (11.x, confirmed in app-shell 3.3.0's federation share scope alongside i18next
 * 19.9.2), `useTranslation()` without an instance returns a `t` that echoes the KEY back --
 * `t('board.title', 'Tasks')` renders the literal "board.title". A board reading
 * "board.columns.due" is a worse outcome than an English one, so the fallback is written here
 * instead, where it can return the default value (interpolated) exactly as i18next would have.
 *
 * The board runs inside the app shell, where i18next is initialized and global and this module's
 * 'tasks' namespace has already been requested (see src/javascript/init.tsx), so the fallback is
 * not the expected path -- it is what keeps the board readable in an embedding that boots this
 * remote some other way. (Until #69 it was the ONLY path for the server-rendered content views,
 * which hydrated on ordinary pages with no shell; those views are gone.)
 *
 * <h3>How the shell's instance is reached</h3>
 * `window.jahia` is the app shell's own entry module (appshell.js: `window.jahia = e`), and its
 * `i18n` export is the initialized i18next singleton (`i18next.use(XHR).use(initReactI18next)
 * .init({lng: contextJsParameters.uilang, fallbackLng: 'en', ...})`). That is the same object
 * init.tsx already calls `loadNamespaces('tasks')` on -- so reading `t` off it, rather than
 * importing i18next ourselves, guarantees we translate through the instance that actually loaded
 * our namespace, and adds no dependency to either bundle.
 *
 * The namespace name IS the URL segment the shell's i18next backend fetches from
 * (`/modules/tasks/javascript/locales/<lang>.json`), which is why it must stay this module's own
 * name -- see the longer note in init.tsx.
 *
 * <h3>The namespace-versus-instance trap</h3>
 * `window.jahia.i18n` is NOT reliably a live i18next instance. On a current shell it is the
 * i18next MODULE NAMESPACE: it carries `t`, `init`, `use`, `createInstance`, `loadNamespaces` and
 * `changeLanguage`, but none of the EventEmitter/store API -- no `on`, `off`, `store`, `options`,
 * `language` or `isInitialized`. The initialized instance sits one level down, at
 * `window.jahia.i18n.default`. The cause is upstream: Jahia's shared i18next module carries no
 * `__esModule` marker, so the federation glue that unwraps a default export (`o.__esModule ?
 * o.default : o`) leaves consumers holding the namespace.
 *
 * Duck-typing on `t` alone therefore finds an object that translates but never emits an event,
 * which silently disables the subscription in useTasksTranslation below AND leaves `language`
 * undefined, so dates stop following the shell's language. {@link appShellI18n} unwraps to the
 * real instance. The same trap took kfind's search modal down outright -- react-i18next called
 * `i18n.on(...)` on the namespace and threw mid-render -- so treat any future "read i18n off the
 * shell" code as needing the same unwrap.
 */

import {useEffect, useMemo, useState} from 'react';

// Must match the module's own artifactId -- see the file header and init.tsx.
const NAMESPACE = 'tasks';

// The subset of the i18next instance API this bridge uses. Structurally typed rather than imported
// from @types/i18next: the instance is reached through a global at runtime, and neither bundle
// depends on the package.
type I18nextInstance = {
    t: (key: string, options?: Record<string, unknown>) => string;
    language?: string;
    on?: (event: string, handler: () => void) => void;
    off?: (event: string, handler: () => void) => void;
};

type ShellGlobals = {
    jahia?: {i18n?: unknown};
    contextJsParameters?: {uilang?: string};
};

/** Interpolation values, plus i18next's own `count` for the plural helper below. */
export type TranslateOptions = Record<string, string | number>;

/**
 * Translate `key`, falling back to `defaultValue` when i18next is absent (no app shell) or the key
 * is missing from the loaded bundle. `defaultValue` is always the English text, so it doubles as
 * the in-source documentation of what the key means -- there is no separate English-only path.
 */
export type Translate = (key: string, defaultValue: string, options?: TranslateOptions) => string;

/**
 * Plural form of {@link Translate}. `one`/`other` are the two English defaults; which one the
 * fallback picks is the English rule (n === 1), while i18next itself applies the ACTIVE language's
 * rule to the locale bundle's `<key>` / `<key>_plural` pair -- so French "0 jour" (singular below
 * 2) comes out right even though the English default for 0 would have been the plural.
 */
export type TranslatePlural = (key: string, count: number, one: string, other: string) => string;

export type Translation = {
    t: Translate;
    tPlural: TranslatePlural;
    /** BCP-47-ish tag for Intl formatting -- see {@link resolveLocale}. */
    locale: string;
};

function shell(): ShellGlobals {
    return globalThis as unknown as ShellGlobals;
}

/**
 * The app shell's i18next instance, or undefined outside the shell.
 *
 * Duck-typed on `t` rather than on the global merely existing: `window.jahia` is also set (to a
 * different shape) by parts of the legacy GWT UI, and an object without `t` must degrade to the
 * defaults rather than throw.
 *
 * Then unwrapped to `.default` when what we found is the module namespace rather than the live
 * instance -- see the header. `on` is the probe because it is exactly what the namespace lacks and
 * what this module needs. A namespace whose `.default` is unusable still returns the namespace:
 * translating without live updates is what this did before the unwrap existed, and is strictly
 * better than degrading to English.
 */
function appShellI18n(): I18nextInstance | undefined {
    const candidate = shell().jahia?.i18n as (I18nextInstance & {default?: I18nextInstance}) | undefined;
    if (typeof candidate?.t !== 'function') {
        return undefined;
    }

    if (typeof candidate.on === 'function') {
        return candidate;
    }

    return typeof candidate.default?.t === 'function' ? candidate.default : candidate;
}

// i18next's own interpolation syntax, so a default value and its locale-file counterpart are the
// same string with the same placeholders.
const INTERPOLATION_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

function interpolate(template: string, options?: TranslateOptions): string {
    if (!options) {
        return template;
    }

    // An unknown placeholder is left verbatim rather than blanked: that makes a typo'd default
    // value visible in the UI instead of silently producing "Created by: , on ".
    return template.replace(INTERPOLATION_PATTERN, (whole, name: string) =>
        (Object.prototype.hasOwnProperty.call(options, name) ? String(options[name]) : whole));
}

/**
 * Which locale Intl should format dates in, most authoritative first:
 * <ol>
 *   <li>the shell's i18next language -- the admin UI language the viewer actually chose;</li>
 *   <li>`preferred`, whatever the board's renderer passed down;</li>
 *   <li>`contextJsParameters.uilang`, the page-level global, for an embedding that has neither;</li>
 *   <li>'en'.</li>
 * </ol>
 */
function resolveLocale(i18n: I18nextInstance | undefined, preferred?: string): string {
    return i18n?.language || preferred || shell().contextJsParameters?.uilang || 'en';
}

/**
 * @param preferredLocale date-formatting locale to use when the app shell isn't there to supply
 * one. Has no effect on `t`: without a shell there is no loaded bundle to translate against
 * either way.
 */
export function useTasksTranslation(preferredLocale?: string): Translation {
    const i18n = appShellI18n();
    // i18next loads namespaces over XHR, so 'tasks' may still be in flight when this first renders
    // (init.tsx requests it at remote-init time, but nothing awaits it). Without this the board
    // would render its English defaults and stay that way until something else re-rendered it.
    // 'added' covers the bundle landing, 'loaded' the backend request completing, and
    // 'languageChanged' a live UI-language switch.
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        if (!i18n?.on) {
            return undefined;
        }

        const handler = () => setRevision(current => current + 1);
        i18n.on('added', handler);
        i18n.on('loaded', handler);
        i18n.on('languageChanged', handler);
        return () => {
            i18n.off?.('added', handler);
            i18n.off?.('loaded', handler);
            i18n.off?.('languageChanged', handler);
        };
    }, [i18n]);

    return useMemo(() => {
        const t: Translate = (key, defaultValue, options) => (i18n
            ? i18n.t(`${NAMESPACE}:${key}`, {defaultValue, ...options})
            : interpolate(defaultValue, options));

        return {
            t,
            // The default handed to i18next is the form matching THIS count, so a missing key
            // degrades to correct English ("3 days"), not to the singular with a 3 in it.
            tPlural: (key, count, one, other) => t(key, count === 1 ? one : other, {count}),
            locale: resolveLocale(i18n, preferredLocale)
        };
        // revision is not read in the body on purpose -- it is here solely to invalidate this memo
        // (and so re-run i18n.t) when i18next reports new resources or a new language.
    }, [i18n, preferredLocale, revision]);
}

/**
 * Intl formatters are expensive to construct and this board builds one per row, so they are cached
 * per (locale, style) rather than rebuilt on every render. Bounded in practice by the number of UI
 * languages a session switches between.
 */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export type DateStyle = 'short' | 'long' | 'dateTime';

const DATE_STYLE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
    // "Aug 15, 2026" -- for the 140px Due column, which also carries the overdue chip and the
    // iCal link.
    short: {year: 'numeric', month: 'short', day: 'numeric'},
    // "August 15, 2026" -- the created-by line, which sits on its own line in the flexible column.
    long: {year: 'numeric', month: 'long', day: 'numeric'},
    // The full stored instant, used only as a tooltip on the (day-precision) due date.
    dateTime: {dateStyle: 'medium', timeStyle: 'short'}
};

function dateFormatter(locale: string, style: DateStyle): Intl.DateTimeFormat {
    const cacheKey = `${locale}|${style}`;
    const cached = dateFormatters.get(cacheKey);
    if (cached) {
        return cached;
    }

    let formatter: Intl.DateTimeFormat;
    try {
        formatter = new Intl.DateTimeFormat(locale, DATE_STYLE_OPTIONS[style]);
    } catch {
        // Intl throws RangeError on a malformed tag, and the locale here comes from a global we
        // don't own -- an unusable one must not take the whole board down with it.
        formatter = new Intl.DateTimeFormat('en', DATE_STYLE_OPTIONS[style]);
    }

    dateFormatters.set(cacheKey, formatter);
    return formatter;
}

/**
 * Formats a stored ISO-8601 instant in the viewer's own locale, or null when there is nothing to
 * show. Shared by every date on the board so a null/unparseable value is handled identically
 * wherever it appears, differing only in the style applied.
 */
export function formatDate(locale: string, style: DateStyle, iso: string | null): string | null {
    if (!iso) {
        return null;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return dateFormatter(locale, style).format(date);
}
