const deps = require('./package.json').dependencies;

/**
 * What this module contributes to the federation pool, and in which of module federation's three
 * buckets. A singleton has to be unique on the page and is provided by the host; a pooled (merely
 * shared) dependency is contributed by every module that declares it, and the highest version
 * within the accepted range wins; anything listed in neither is private - bundled and tree-shaken,
 * which is where @jahia/moonstone-alpha sits.
 *
 * Both lists are spread into the result below, singletons last, so a package named in both ends up
 * a singleton. Keep each package in exactly one of them.
 */
const sharedDeps = [
    // Pooled rather than singleton since app-shell 4: the host no longer provides Moonstone as a
    // unique copy, it deduplicates the copies the modules contribute. Declaring it a singleton
    // against a host that does not provide one is a mismatch, not a stricter guarantee.
    '@jahia/moonstone'
];

// Provided by the app-shell, which since version 4 is the host for every singleton and loads them
// before any UI extension. The version declared here therefore selects nothing -- a range that
// excludes what the host provides only logs "Unsatisfied version ... of shared singleton module"
// in the console and gets the host's copy anyway. It still has to be kept honest, because that
// warning is the only signal that this module was never tested against what it actually runs on.
const singletonDeps = [
    'react',
    'react-dom',
    '@jahia/ui-extender'
];

module.exports = {
    ...sharedDeps.reduce((acc, item) => ({
        ...acc,
        [item]: {
            requiredVersion: deps[item]
        }
    }), {}),
    ...singletonDeps.reduce((acc, item) => ({
        ...acc,
        [item]: {
            singleton: true,
            requiredVersion: deps[item]
        }
    }), {})
};
