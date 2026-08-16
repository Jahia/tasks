import {useEffect, useState} from 'react';
import {Banner, Loader} from '@jahia/moonstone';
import TaskBoard, {DEFAULT_PAGE_SIZE} from '../client/components/TaskBoard.client';
import {callGraphQL} from '../client/lib/graphqlClient';
import {useTasksTranslation} from '../client/lib/i18n';
import {DEFAULT_SORT_BY, DEFAULT_SORT_ORDER, INITIAL_TASK_BOARD_QUERY, NOT_FINISHED_STATES, pickInitialScope} from '../client/components/taskBoard.shared';
import type {InitialTaskBoardQueryResult} from '../client/components/taskBoard.shared';

// Must match TaskBoard's own itemsPerPage default -- otherwise the first page fetched here
// (before TaskBoard's itemsPerPage state exists) would disagree with the page size TaskBoard
// starts life expecting once it takes over pagination.
const PAGE_SIZE = DEFAULT_PAGE_SIZE;
// Relative to the current origin -- there's no SSR-side buildEndpointUrl() helper available
// here (that's part of @jahia/javascript-modules-library, forbidden outside server components),
// but a plain relative path resolves correctly from a route rendered in the browser.
const GRAPHQL_ENDPOINT = '/modules/graphql';

/**
 * The language the server resolves workflow outcome labels in (GqlTaskBoard#getPossibleOutcomeDetails).
 * This route has no server render pass to inherit a locale from, so it reads the admin shell's own
 * UI language off the page's jahiaGWTParameters global -- the same object the shell publishes as
 * window.contextJsParameters -- cast locally for the same reason init.tsx casts for
 * window.jahia.i18n: no ambient type declares it.
 *
 * Undefined when that global isn't there (an embedding that boots this remote some other way):
 * the language argument is optional, and the server then falls back to the request's own locale.
 */
function uiLanguage(): string | undefined {
    const shell = globalThis as unknown as {contextJsParameters?: {uilang?: string}};
    return shell.contextJsParameters?.uilang;
}

type LoadState =
    | {status: 'loading'}
    | {status: 'error'; message: string}
    | {status: 'ready'; data: InitialTaskBoardQueryResult};

/**
 * Entry point for the 'tasks' adminRoute (see ../javascript/init.tsx), which overrides
 * jahia-dashboard's own built-in 'tasks' dashboard tab (normally an iframe onto the
 * jnt:user 'tasks' content template -- see init.tsx for why that never renders any content).
 * Unlike CurrentUserTasksView.server.tsx (the jnt:currentUserTasks content view, SSR-fetched),
 * this route is mounted directly by the admin shell with no server-side render pass, so it
 * fetches its own initial page here instead of receiving it as a prop.
 */
export function TasksDashboardApp() {
    // This route runs inside the app shell, so i18next is initialized here and init.tsx has already
    // asked it for the 'tasks' namespace -- these two strings are the only ones this wrapper owns,
    // the board itself translating everything else.
    const {t} = useTasksTranslation();
    const [state, setState] = useState<LoadState>({status: 'loading'});

    const language = uiLanguage();

    useEffect(() => {
        let cancelled = false;
        callGraphQL<InitialTaskBoardQueryResult>(GRAPHQL_ENDPOINT, INITIAL_TASK_BOARD_QUERY, {
            first: PAGE_SIZE,
            filterState: NOT_FINISHED_STATES,
            sortBy: DEFAULT_SORT_BY,
            sortOrder: DEFAULT_SORT_ORDER,
            language: language ?? null
        })
            .then(data => {
                if (!cancelled) {
                    setState({status: 'ready', data});
                }
            })
            .catch(e => {
                if (!cancelled) {
                    setState({status: 'error', message: e instanceof Error ? e.message : t('common.error.load', 'Unable to load tasks.')});
                }
            });
        return () => {
            cancelled = true;
        };
        // Effectively mount-only: uiLanguage() reads a global the page sets before any remote
        // loads, so this never actually changes for the life of the route.
    }, [language, t]);

    if (state.status === 'loading') {
        return <Loader/>;
    }

    if (state.status === 'error') {
        return <Banner role="alert" title={t('common.error.title', 'Something went wrong')} variant="danger">{state.message}</Banner>;
    }

    // The initial query returns page 1 of all three scopes; the board opens on the first one that
    // has anything in it (see pickInitialScope) and takes that scope's page as its initial state.
    const initialScope = pickInitialScope(state.data);

    return (
        <TaskBoard
            initialConnection={state.data[initialScope]}
            initialScope={initialScope}
            graphqlEndpoint={GRAPHQL_ENDPOINT}
            currentUserKey={state.data.taskBoardCurrentUserKey}
            canReviewAll={state.data.taskBoardCanReviewAll}
            language={language}
        />
    );
}
