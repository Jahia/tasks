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
            chunkFilename: '[name].tasks.[chunkhash:6].js',
            clean: true
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
        mode: 'development'
    };

    config.devtool = (argv.mode === 'production') ? 'source-map' : 'eval-source-map';

    return config;
};
