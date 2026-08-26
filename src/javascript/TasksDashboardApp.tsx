import {useQuery} from '@apollo/client';
import {Banner, Loader} from '@jahia/moonstone';
import TaskBoard, {DEFAULT_PAGE_SIZE} from '../client/components/TaskBoard.client';
import {graphqlErrorMessage} from '../client/lib/graphqlErrors';
import {useTasksTranslation} from '../client/lib/i18n';
import {DEFAULT_SORT_BY, DEFAULT_SORT_ORDER, INITIAL_SCOPE, INITIAL_TASK_BOARD_QUERY, NOT_FINISHED_STATES} from '../client/components/taskBoard.shared';
import type {InitialTaskBoardQueryResult} from '../client/components/taskBoard.shared';

// Must match TaskBoard's own itemsPerPage default -- otherwise the first page fetched here
// (before TaskBoard's itemsPerPage state exists) would disagree with the page size TaskBoard
// starts life expecting once it takes over pagination.
const PAGE_SIZE = DEFAULT_PAGE_SIZE;

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

/**
 * Entry point for the 'tasks' adminRoute (see ../javascript/init.tsx), which overrides
 * jahia-dashboard's own built-in 'tasks' dashboard tab (normally an iframe onto the
 * jnt:user 'tasks' content template -- see init.tsx for why that never renders any content).
 *
 * This route is mounted directly by the admin shell with no server-side render pass, so it fetches
 * its own first page here and hands it to the board as initialConnection. That was already true
 * before #69; what changed is that it is now the module's ONLY renderer of the board -- the
 * server-rendered jnt:currentUserTasks view that used to fetch the same page through
 * javascript-modules-engine is gone.
 *
 * No ApolloProvider anywhere in this module: the app shell registers one at target root:12,
 * wrapping the whole React tree that every registered route renders inside, so useQuery here binds
 * to the shell's own client and shares its link. (Verified in app-shell's own bundle; jcontent's
 * route calls useApolloClient() the same way, with no provider of its own.)
 */
export function TasksDashboardApp() {
    // This route runs inside the app shell, so i18next is initialized here and init.tsx has already
    // asked it for the 'tasks' namespace -- these two strings are the only ones this wrapper owns,
    // the board itself translating everything else.
    const {t} = useTasksTranslation();
    const language = uiLanguage();

    // no-cache, like every other operation this board runs: the result is a cursor-paginated
    // connection the board re-fetches itself on every change, and it is handed straight to
    // TaskBoard as its initial state rather than ever being read back from the cache. Writing it
    // to the shell's normalized cache would buy nothing here and would put a page-shaped,
    // argument-keyed connection into a cache other modules read for whole nodes.
    const {data, loading, error} = useQuery<InitialTaskBoardQueryResult>(INITIAL_TASK_BOARD_QUERY, {
        variables: {
            first: PAGE_SIZE,
            filterState: NOT_FINISHED_STATES,
            sortBy: DEFAULT_SORT_BY,
            sortOrder: DEFAULT_SORT_ORDER,
            language: language ?? null
        },
        fetchPolicy: 'no-cache'
    });

    if (loading) {
        return <Loader/>;
    }

    // `data` is undefined whenever `error` is set: the default errorPolicy discards partial data,
    // which is what the hand-rolled client this replaced did too. The second half of the condition
    // is therefore about the impossible case, and exists so the render below can dereference
    // `data` without a non-null assertion.
    if (error || !data) {
        return (
            <Banner role="alert" title={t('common.error.title', 'Something went wrong')} variant="danger">
                {graphqlErrorMessage(error, t('common.error.load', 'Unable to load tasks.'))}
            </Banner>
        );
    }

    // The initial query returns page 1 of the scope the board opens on -- "All tasks" for every
    // viewer (see INITIAL_SCOPE) -- and that page is the board's initial state.
    return (
        <TaskBoard
            initialConnection={data[INITIAL_SCOPE]}
            initialScope={INITIAL_SCOPE}
            currentUserKey={data.taskBoardCurrentUserKey}
            canReviewAll={data.taskBoardCanReviewAll}
            language={language}
        />
    );
}
