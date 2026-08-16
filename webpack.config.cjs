const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const ModuleFederationPlugin = require('webpack/lib/container/ModuleFederationPlugin');
const shared = require('./webpack.shared.cjs');

module.exports = (env, argv) => {
    const config = {
        entry: {
            main: [path.resolve(__dirname, 'src/javascript/federation-entry.ts')]
        },
        output: {
            path: path.resolve(__dirname, 'src/main/resources/javascript/apps/'),
            filename: 'tasks.bundle.js',
            chunkFilename: '[name].tasks.[chunkhash:6].js'
            // No `clean: true`: on a Windows dev box with an on-access endpoint-security scanner
            // (e.g. Kaspersky-style real-time protection), webpack's clean step tries to unlink
            // the previous build's now-stale content-hashed chunk files right as the scanner has
            // them open, which fails the whole build with EBUSY/"used by another process". Old
            // chunks are unreferenced by remoteEntry.js once superseded, so leaving them behind is
            // functionally harmless within a dev loop -- and both `yarn clean` (package.json) and
            // `mvn clean` wipe this directory between real clean builds, so they never accumulate
            // into the packaged jar. The latter needed an explicit maven-clean-plugin fileset: the
            // plugin's default only reaches target/, and this directory is not under it (18 stale
            // chunks had made it into the jar before that was noticed, #62).
        },
        resolve: {
            mainFields: ['module', 'main'],
            extensions: ['.mjs', '.js', '.jsx', '.ts', '.tsx', '.json']
        },
        module: {
            rules: [
                {
                    test: /\.m?js$/,
                    type: 'javascript/auto'
                },
                {
                    test: /\.[jt]sx?$/,
                    include: [path.join(__dirname, 'src')],
                    use: {
                        loader: 'babel-loader',
                        options: {
                            presets: [
                                ['@babel/preset-env', {modules: false, targets: {esmodules: true}}],
                                ['@babel/preset-react', {runtime: 'automatic'}],
                                '@babel/preset-typescript'
                            ]
                        }
                    }
                }
            ]
        },
        plugins: [
            new ModuleFederationPlugin({
                name: 'tasks',
                library: {type: 'assign', name: 'appShell.remotes.tasks'},
                filename: 'remoteEntry.js',
                exposes: {
                    './init': './src/javascript/init.tsx'
                },
                remotes: {
                    '@jahia/jahia-ui-root': 'appShell.remotes.jahiaUi',
                    '@jahia/app-shell': 'appShellRemote'
                },
                shared
            }),
            new CopyWebpackPlugin({patterns: [{from: './package.json', to: ''}]})
        ],
        // Whatever --mode the invocation asked for, development for a bare `webpack` run.
        // The packaged build is not that bare run: package.json's "build" script -- the one
        // the Maven frontend plugin calls -- passes "--mode production" explicitly, so the
        // chunks that end up in the jar are minified. The flag lives there rather than in this
        // default, so a hand-run `webpack` on a dev box stays a fast, readable build.
        mode: argv.mode === 'production' ? 'production' : 'development'
    };

    config.devtool = (argv.mode === 'production') ? 'source-map' : 'eval-source-map';

    return config;
};
