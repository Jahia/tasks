<a href="https://www.jahia.com/">
    <img src="https://www.jahia.com/modules/jahiacom-templates/images/jahia-3x.png" alt="Jahia logo" title="Jahia" align="right" height="60" />
</a>

Tasks
======================
Digital Experience Manager module for leveraging simple user and shared task management.

## Open-Source

This is an Open-Source module, you can find more details about Open-Source @ Jahia [in this repository](https://github.com/Jahia/open-source).

## Known limitations

**"My workspace → My tasks" shows "No item found".** This module registers a
`jnt:currentUserTasks` React view (`jahiaComponent()`) that renders correctly
wherever the node is placed on a page, and it also ships a `tasks` content
template (`src/main/import/repository.xml`, under `dashboard-modules-base`,
applied to `jnt:user`) so the task board can be embedded as a personal
dashboard tile. The "My tasks" entry under "My workspace" in Jahia's
back-office is itself registered by the core `jahia-dashboard` module (not by
this one) as an iframe pointing at
`/cms/dashboardframe/.../users/<you>.tasks.html`.

That iframe currently renders "No item found": the template's default
`pagecontent/my-tasks/currentUserTasks` content exists at the module's own
template-definition path, but is never materialized onto the live
`/users/<username>` node, so rendering fails before it reaches this module's
React view at all (confirmed via server logs — no trace of the view being
invoked for that request). This is a Jahia-core template-area-inheritance
question (why a `jnt:contentTemplate`'s default area content isn't inherited
for a `jnt:user` target the way it is for `jnt:page`), not a bug in this
module's view registration. Embedding the `jnt:currentUserTasks` view on a
regular page works as expected.
