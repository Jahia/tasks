# Tasks Module — What Changed

A plain-language summary of the recent work on this module (the React Task Board,
its GraphQL backend, and how it's wired into Jahia).

## 1. What was added or changed

- **Replaced the old legacy views with a React Task Board.** The old JSP/JSTL
  screens are gone. Tasks are now shown in a **Moonstone Datatable** with columns
  for Task Name, Creator, Owner, State, and an Actions menu (the 3-dot menu, like
  jContent).
- **Server-side pagination.** The table doesn't load every task at once — it
  fetches pages of 20 through GraphQL, using cursor-based ("Relay style")
  pagination.
- **New GraphQL API for tasks**, added in Java under
  `src/main/java/org/jahia/modules/tasks/graphql/`:
  - `taskBoard` — the paginated query that lists tasks.
  - Mutations: `assignTaskToMe`, `unassignTask`, `suspendTask`, `resumeTask`,
    `completeTask`.
- **Action menu is state-aware.** Depending on a task's state (active, started,
  suspended) and whether you're the owner, different actions show up:
  Assign to me, Unassign/Refuse, Suspend, Resume, Publish/Reject (the workflow
  outcomes), and Preview.
- **Security (RBAC) enforced on the server, not just the UI.** A new
  `TaskAuthorizationService` is the single place that decides who can see/act on
  which task. The React side also hides buttons a user shouldn't see, but that's
  just a UX nicety — the Java service independently re-checks every action, so a
  user can't bypass the rules by calling the GraphQL mutation directly.
- **Two places this UI can appear:**
  1. As a **content view** (`jnt:currentUserTasks`) that can be dropped onto any
     page — this one is server-rendered (SSR) for the first page load.
  2. As an **admin dashboard route** (`tasksDashboard`) reached from the app
     shell — this one fetches its own first page in the browser since there's
     no SSR pass for it.
- **Clear empty/error states.** If there are no tasks, the table shows
  "No tasks to show." instead of a blank table. If the GraphQL call fails, a red
  error banner is shown instead of crashing.
- **Cypress end-to-end tests** were added to automate testing of the board.
- Legacy GWT/Spring dashboard code and duplicate/dead files were removed as part
  of cleanup.

## 2. How the routing / logic works now

- **Two entry points, one shared component:**
  - `CurrentUserTasksView.server.tsx` — registered as the view for the
    `jnt:currentUserTasks` content type. Runs on the server first (SSR), fetches
    the first page of tasks via GraphQL, then hands off to the same
    `TaskBoard` component on the client for pagination/actions.
  - `TasksDashboardApp.tsx` — mounted by a `tasksDashboard` route registered in
    `init.tsx`. No SSR here, so it fetches its own first page directly in the
    browser using `useEffect`.
- **`TaskBoard.client.tsx`** is the shared piece both entry points render. It:
  - Keeps track of the current page and a cache of pagination cursors (so going
    back to a page you've already seen doesn't require re-fetching everything).
  - Sends GraphQL queries/mutations via a plain `fetch()` wrapper
    (`callGraphQL`), not the server-only Jahia library (that library can't be
    used in client-side code).
  - Decides which action-menu buttons to show, based on the task's state and
    whether the current user owns it or has "review all" rights.
- **Every query/mutation string lives in one shared file**
  (`taskBoard.shared.ts`) so the SSR view and the client island always send
  exactly the same GraphQL.
- **On the server (Java)**, `TaskBoardQueryExtensions` / `TaskBoardMutationExtensions`
  handle the actual GraphQL resolution, and always ask
  `TaskAuthorizationService` "is this user allowed to do this?" before doing
  anything — regardless of what the UI already hid.

## 3. Known issues

- **"My workspace → My tasks" shows "No item found."**
  - This dashboard tile is registered by Jahia core (the `jahia-dashboard`
    module), not by this module. It points at an iframe URL
    (`/cms/dashboardframe/.../users/<you>.tasks.html`).
  - This module does ship a `tasks` content template meant to back that page,
    but that template's default content is never actually materialized onto
    the live `/users/<username>` node — so the page fails to render before it
    ever reaches this module's React view. Server logs confirm the view is
    never even invoked for that request.
  - This looks like a **Jahia-core limitation** in how template-area content is
    (or isn't) inherited for a `jnt:user` target, the same way it is for a
    `jnt:page` — not a bug in this module's own view registration.
  - **Workaround / what does work:** dropping the `jnt:currentUserTasks`
    component directly onto a normal page works correctly and shows the full
    Task Board.
- **The `tasksDashboard` admin route may not actually be wired up.** As of the
  currently published `@jahia/ui-extender` version, the admin shell doesn't
  read a `route`/`dashboard` registry entry at all (it only consumes
  `adminRoute`). So `TasksDashboardApp` is registered, but there may be nothing
  in the shell that renders it yet — this needs to be confirmed against a
  newer `ui-extender` or a different registration approach.
- **`canReviewAllTasks` is scoped to a single node for now.** It checks the
  "publish" permission on one scope node. Once tasks need to be listed across
  multiple sites, this check will need to become per-site rather than one
  global yes/no.
