// One site per spec file, all derived from the same prefix so the run-level cleanup in e2e.ts can
// remove every one of them without each spec having to register itself there. Cypress runs specs
// sequentially, so distinct keys are not about concurrency -- they are about a spec that crashes
// mid-run not leaving a site behind that the NEXT spec would then find already populated.
export const TEST_SITE_KEY = 'tasks-e2e-test';
export const BOARD_SITE_KEY = `${TEST_SITE_KEY}-board`;
export const DETAIL_SITE_KEY = `${TEST_SITE_KEY}-detail`;
export const LIST_SITE_KEY = `${TEST_SITE_KEY}-list`;
export const VISIBILITY_SITE_KEY = `${TEST_SITE_KEY}-visibility`;
export const REVIEW_SITE_KEY = `${TEST_SITE_KEY}-review`;
export const UI_SITE_KEY = `${TEST_SITE_KEY}-ui`;
export const SCHEDULE_SITE_KEY = `${TEST_SITE_KEY}-schedule`;

export const ALL_TEST_SITE_KEYS = [
    TEST_SITE_KEY,
    BOARD_SITE_KEY,
    DETAIL_SITE_KEY,
    LIST_SITE_KEY,
    VISIBILITY_SITE_KEY,
    REVIEW_SITE_KEY,
    UI_SITE_KEY,
    SCHEDULE_SITE_KEY
];

// This module ships no template set of its own (jahia-module-type=system, embeddable on any site),
// and none of these specs render a site page: the API specs never leave GraphQL, and the UI spec
// drives the admin dashboard route, which is served by the app shell rather than by a site
// template. So the suite deliberately uses `templates-system` -- the ONLY templatesSet a stock
// Jahia EE has without installing anything (verified with
// JahiaTemplateManagerService#getAvailableTemplatePackages on a clean 8.2.3) -- instead of
// dx-base-demo-templates, whose install pulls a dozen further modules (bootstrap3-core/-components,
// skins, default-skins, bookmarks, font-awesome, grid, event, location, news, person, topstories,
// dx-base-demo-core/-components) and, resolved as a snapshot, does not start at all. Nothing in
// these specs needs that content, so the whole tree was dropped from the provisioning manifest.
export const TEST_TEMPLATE_SET = 'templates-system';

export const PAGE_SIZE = 20;

// The standard Jahia role granting the "publish" permission TaskAuthorizationService#canReviewAllTasks
// uses as its reviewer-capability proxy. Granted at "/" it makes a reviewer of the whole repository;
// granted on ONE SITE to a group it is also what makes that group a real workflow-review candidate
// (see startPublicationReview in support/taskFixtures.ts).
export const REVIEWER_ROLE = 'editor-in-chief';

// jnt:task/jnt:workflowTask only ever lives in the edit/default workspace (see
// TaskBoardQueryExtensions' class comment). The standard "reader" role only grants jcr:read_live,
// so every non-root persona in these specs needs "privileged" (jcr:read_default) to read a task
// node at all, independently of any task-level eligibility.
export const PRIVILEGED_ROLE = 'privileged';

// Every persona in the suite uses the same throwaway password -- created and deleted by the spec
// that uses it, never existing outside a test run.
export const TEST_PASSWORD = 'password123';

// The publication workflow every workflow-task fixture starts. "<provider>:<definition key>", the
// form jcr.mutateNode.startWorkflow expects; both halves confirmed against
// WorkflowService#getWorkflows on the instance under test.
export const PUBLICATION_WORKFLOW = 'jBPM:1-step-publication';

/**
 * A fixture node name that is unique to this run.
 *
 * <p><b>Why any of this is needed.</b> The run-level cleanup in support/e2e.ts deletes every test
 * SITE, which is enough for everything that lives in the JCR. It is not enough for anything that
 * starts a real workflow: the engine keeps its own process store, outside the repository, and
 * indexes it by the process's {@code nodePath} VARIABLE (see GetHistoryWorkflowsForPathCommand,
 * whose query is `FROM VariableInstanceLog WHERE variableId = 'nodePath' AND value LIKE ...`).
 * Deleting the content does not delete those rows. So on a persistent instance -- which is exactly
 * what the local docker bench is, being started and stopped rather than recreated -- a second run
 * of a spec that starts a publication on a FIXED path finds the previous run's finished process
 * still sitting in the engine's history, at the very path it is about to reuse.
 *
 * <p>That is not hypothetical: it is what made task-schedule-workflow's "empty while running"
 * assertion fail on the second run (a just-started process cannot have an ENDED step, so the
 * history entry it saw could only have come from an earlier run). Giving the target a per-run name
 * makes the path itself new, which is the only thing that puts the engine's answer back under the
 * spec's control -- and it keeps the assertion saying what it means ("this workflow declares no
 * due-dated or completed steps yet") instead of being loosened to tolerate strangers.
 *
 * <p>Evaluated once per spec file, at import time; each spec runs in its own browser context, so
 * two specs never share a value and never need to.
 */
export function runScopedName(base: string): string {
    return `${base}-${Date.now()}`;
}
