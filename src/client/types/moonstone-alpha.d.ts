// @jahia/moonstone-alpha ships compiled type declarations (dist/components/ContentLayout/ContentLayout.d.ts)
// but its package.json declares no "types"/"typings" field pointing at them, so TypeScript can't
// resolve them through the package's "main" entry (dist/lib/main.js) on its own. This is the
// minimal ambient shape this module actually uses, confirmed against that dist .d.ts.
//
// Declared against the deep import path (not the bare package name) -- see the import site in
// TaskBoard.client.tsx for why the barrel entry point is avoided.
declare module '@jahia/moonstone-alpha/dist/components/ContentLayout' {
    import type {FC, ReactNode} from 'react';

    export const ContentLayout: FC<{
        header?: ReactNode;
        content: ReactNode;
        paper: boolean;
    }>;
}
