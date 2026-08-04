import {registry} from '@jahia/ui-extender';
import {Task} from '@jahia/moonstone';
import {TasksDashboardApp} from './TasksDashboardApp';

// window.jahia.i18n is set up by the app shell before any remote's init() runs (see e.g.
// personal-api-tokens' own init.js), but @jahia/ui-extender's own Window.jahia type declares
// only { ui: {...} } (see its IframeRenderer.d.ts) -- re-declaring the global here to add
// i18n would conflict with that existing declaration, so this casts locally instead.
const jahiaGlobal = window as unknown as {jahia?: {i18n?: {loadNamespaces: (namespace: string) => void}}};

// jahia-dashboard's own built-in 'tasks' adminRoute (dashboard:50, see
// jahia-dashboard/src/javascript/Dashboard/Dashboard.adminRoute.jsx) iframes to
// <userpath>.tasks.html -- i.e. it renders /users/<user> through the 'tasks' jnt:contentTemplate
// (j:applyOn="jnt:user") declared in src/main/import/repository.xml. That template's
// "pagecontent" area never surfaces the jnt:currentUserTasks node materializeDashboardTile()
// puts on the user node (see rules/Tasks.java) -- confirmed by rendering the iframe URL
// directly: 200 OK, but the area's own JSP prints its generic "No item found" fallback. That
// gap is in Jahia's base dashboard-template rendering, not fixable from this module.
//
// So this module overrides that tab outright: same registry key ('tasks') and target
// (dashboard:50) as jahia-dashboard's own registration, replaced with TasksDashboardApp, which
// fetches the exact same taskBoard data over GraphQL instead of relying on template inheritance.
// registry.add() throws if the key already exists (ui-extender's registry.js), so this uses
// addOrReplace(), and needs to run AFTER jahia-dashboard's own 'dashboard' callback
// (jahiaApp-init:5) so this registration is the one left standing.
//
// Root cause of the ordering, confirmed by reading app-shell's own dispatch code
// (appShell.js, ~line 94): it collects the distinct jahiaApp-init priorities and calls
// `.sort()` with NO comparator, so priorities are compared as STRINGS, not numbers --
// e.g. Number.prototype priority 20 sorts BEFORE 5, because "20" < "5" lexicographically.
// That's an app-shell bug (worth reporting upstream), but until it's fixed, this priority
// has to be chosen to win the string-sort, not the numeric one. "6" sorts after "5" both
// ways, which is why it's used here instead of a numerically-obvious 1 (which sorted
// as "1" < "5" and lost) or the previous 20 (which sorted as "20" < "5" and won by
// accident, but crashed since jahia-dashboard's own registration used plain add() then).
//
// (A previous 'route'/'dashboard:10' registration here, mounting a standalone TasksDashboardApp,
// was dead code: type 'route' is only ever consumed for 'main:N' targets by jahia-dashboard's own
// routeDashboard registration -- 'dashboard:N' targets are read exclusively as type 'adminRoute'.)
export default function () {
    // The namespace here IS the URL segment app-shell's i18next backend fetches from
    // (loadPath in app-shell's i18n.js: `/modules/${namespace}/javascript/locales/${lang}.json`,
    // see e.g. personal-api-tokens' own locales/en.json at that exact module-relative path) --
    // it has to be this module's own name ("tasks"), not the Java-side resource bundle's base
    // name ("JahiaTasks", used only by server-rendered JSPs/.properties files, a separate,
    // unrelated i18n system). Resolves the label below via src/main/resources/javascript/
    // locales/{en,de,fr}.json.
    jahiaGlobal.jahia?.i18n?.loadNamespaces('tasks');

    registry.add('callback', 'TasksEngineEditor', {
        targets: ['jahiaApp-init:6'],
        callback: () => {
            registry.addOrReplace('adminRoute', 'tasks', {
                targets: ['dashboard:50'],
                icon: <Task/>,
                label: 'tasks:jnt_task.myTasks',
                isSelectable: true,
                render: () => <TasksDashboardApp/>
            });

            console.debug('%c Tasks Engine Extensions is activated', 'color: #3c8cba');
        }
    });
}
