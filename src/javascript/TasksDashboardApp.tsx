import {useEffect, useState} from 'react';
import {Banner, Loader} from '@jahia/moonstone';
import TaskBoard, {DEFAULT_PAGE_SIZE} from '../client/components/TaskBoard.client';
import {callGraphQL} from '../client/lib/graphqlClient';
import {INITIAL_TASK_BOARD_QUERY, initialBoardVariables} from '../client/components/taskBoard.shared';
import type {InitialTaskBoardQueryResult} from '../client/components/taskBoard.shared';

// Must match TaskBoard's own itemsPerPage default -- otherwise the first page fetched here
// (before TaskBoard's itemsPerPage state exists) would disagree with the page size TaskBoard
// starts life expecting once it takes over pagination.
const PAGE_SIZE = DEFAULT_PAGE_SIZE;
// Relative to the current origin -- there's no SSR-side buildEndpointUrl() helper available
// here (that's part of @jahia/javascript-modules-library, forbidden outside server components),
// but a plain relative path resolves correctly from a route rendered in the browser.
const GRAPHQL_ENDPOINT = '/modules/graphql';

// The shell's i18next instance, which init.tsx asks to load this module's 'tasks' namespace
// (src/main/resources/javascript/locales). Cast locally for the reason given in init.tsx.
type ShellI18n = {
    loadNamespaces: (namespace: string) => Promise<unknown>;
    t: (key: string) => string;
};
const shellI18n = (): ShellI18n | undefined =>
    (globalThis as unknown as {jahia?: {i18n?: ShellI18n}}).jahia?.i18n;

type LoadState =
    | {status: 'loading'}
    | {status: 'error'; message: string}
    | {status: 'ready'; data: InitialTaskBoardQueryResult; title: string};

/**
 * Entry point for the 'tasks' adminRoute (see ../javascript/init.tsx), which overrides
 * jahia-dashboard's own built-in 'tasks' dashboard tab (normally an iframe onto the
 * jnt:user 'tasks' content template -- see init.tsx for why that never renders any content).
 * Unlike CurrentUserTasksView.server.tsx (the jnt:currentUserTasks content view, SSR-fetched),
 * this route is mounted directly by the admin shell with no server-side render pass, so it
 * fetches its own initial page here instead of receiving it as a prop.
 */
export function TasksDashboardApp() {
    const [state, setState] = useState<LoadState>({status: 'loading'});

    useEffect(() => {
        let cancelled = false;
        const i18n = shellI18n();
        // The title waits for the translations as well as for the tasks, so the board never
        // shows a raw key before its namespace has arrived.
        Promise.all([
            callGraphQL<InitialTaskBoardQueryResult>(GRAPHQL_ENDPOINT, INITIAL_TASK_BOARD_QUERY,
                initialBoardVariables(PAGE_SIZE)),
            i18n?.loadNamespaces('tasks')
        ])
            .then(([data]) => {
                if (!cancelled) {
                    setState({status: 'ready', data, title: i18n ? i18n.t('tasks:jnt_task.myTasks') : 'jnt_task.myTasks'});
                }
            })
            .catch(e => {
                if (!cancelled) {
                    setState({status: 'error', message: e instanceof Error ? e.message : 'Unable to load tasks.'});
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (state.status === 'loading') {
        return <Loader/>;
    }

    if (state.status === 'error') {
        return <Banner title="Something went wrong" variant="danger">{state.message}</Banner>;
    }

    return (
        <TaskBoard
            title={state.title}
            initialColumns={state.data}
            graphqlEndpoint={GRAPHQL_ENDPOINT}
            currentUserKey={state.data.taskBoardCurrentUserKey}
            canReviewAll={state.data.taskBoardCanReviewAll}
        />
    );
}
