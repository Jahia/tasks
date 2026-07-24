Please review your previous output against the updated requirements below to check if we are fully aligned.

### Objective
We are building a standalone, modern Jahia 8 module using pure Jahia development standards: OSGi, GraphQL, React, and Jahia Moonstone.

---

### Key Requirements Checklist

1. UI & Layout
- Design System: Jahia Moonstone (https://github.com/Jahia/moonstone)
- Layout: Classic Layout (Header, Toolbar, Moonstone Datatable)
- Features: Server-side Pagination required.
- Out of Scope: Multiselect & Multiselect Actions.

2. Table Columns & State-based Actions
- Columns: Task Name, Creator, Owner, State, Actions (3-dot menu like jContent)
- Actions (dependent on task state and assignee):
  - Assign to me
  - Unassign / Refuse
  - Suspend
  - Preview
  - Reject publication
  - Publish

3. Backend, API & Security (RBAC)
- Query/Schema: Identify or build a paginated GraphQL root query to fetch tasks.
- Security: Role-Based Access Control (RBAC) must be strictly enforced on the server-side (OSGi / GraphQL resolvers).

4. Edge Cases & QA
- States: Clear "Empty" and "Error" table states.
- Testing: Automated E2E testing using Cypress.

---

### Proposed Execution Plan
- Phase 1: API Validation & GraphQL Extension (Verify/build paginated task queries and OSGi service).
- Phase 2: Module Setup & Jahia UI Registration (Create clean React module structure and register menu entry).
- Phase 3: Read-Only UI (Build Moonstone Datatable with server-side pagination and GraphQL integration).
- Phase 4: Actions & Mutations (Implement the 3-dot action menu, state logic, and GraphQL mutations).
- Phase 5: QA & Automation (Write Cypress E2E tests).

---

### Your Task
1. Briefly evaluate your previous code against this checklist. Confirm what is already correct and what needs adjustment (especially ensuring we use React/Moonstone/GraphQL instead of legacy JSP/JSTL).
2. Proceed with Phase 1 & Phase 2 based on your evaluation: provide the GraphQL Schema/Query and the initial React component structure using Moonstone (`Table`, `Pagination`).



Update: We have already completed Phase 1 and Phase 2 yesterday. Please read the requirements above to understand the context, and let's directly start working on Phase 3 (Read-Only UI) now.