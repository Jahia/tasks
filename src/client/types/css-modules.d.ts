// Vite rewrites a *.module.css import into an object of {localName: hashedName}, but it is the
// BUNDLER that does so -- TypeScript only sees an import of a .css file and has no idea what it
// resolves to. Without this, `import styles from './X.module.css'` is a "cannot find module" error.
//
// Typed as a string index rather than as the actual class names: generating those would mean a
// codegen step (vite-plugin-sass-dts and friends) for one stylesheet, and the trade is that
// `styles.typo` is undefined at runtime rather than a compile error. The lint rule that would
// catch it does not exist either way, so the cost is the same and the toolchain stays smaller.
declare module '*.module.css' {
    const classes: Readonly<Record<string, string>>;
    export default classes;
}
