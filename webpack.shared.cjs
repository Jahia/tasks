const deps = require('./package.json').dependencies;

const sharedDeps = [
    'react',
    'react-dom',

    // JAHIA PACKAGES
    '@jahia/ui-extender',
    '@jahia/moonstone'
];

const singletonDeps = [
    'react',
    'react-dom',
    '@jahia/ui-extender',
    '@jahia/moonstone'
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
