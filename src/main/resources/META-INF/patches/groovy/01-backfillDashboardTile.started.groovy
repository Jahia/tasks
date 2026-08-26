import org.jahia.services.content.JCRCallback
import org.jahia.services.content.JCRNodeIteratorWrapper
import org.jahia.services.content.JCRNodeWrapper
import org.jahia.services.content.JCRSessionWrapper
import org.jahia.services.content.JCRTemplate
import org.jahia.services.query.QueryWrapper

import javax.jcr.query.Query

/**
 * Backfills the "My tasks" dashboard tile onto every user that already existed before the
 * "materialize on new user" rule (see Tasks#materializeDashboardTile) started reacting to
 * new-user creation -- a JCR-SQL2 query rather than a raw /users tree walk, since user storage
 * may be sharded into subfolders.
 *
 * Runs on bundle start (the ".started" suffix): a plain, non-"started" bundled groovy resource
 * is registered as a view script but is NOT executed by Jahia -- confirmed by deploying both and
 * checking the logs, only the ".started" variant actually ran. Cheap to repeat: each user is
 * skipped once it already has the tile, so re-running on every restart is a no-op for a platform
 * that has already been backfilled.
 *
 * Duplicates Tasks#materializeDashboardTile's node-creation logic rather than calling it: the
 * engine that runs a bundled ".started.groovy" patch cannot load the bundle's own classes --
 * confirmed by a MissingPropertyException ("No such property: Tasks") at runtime -- only core
 * org.jahia.services.* API classes resolve. Keep the two copies in sync if either changes (the
 * same caveat Tasks.java already calls out for its own mirroring of the "tasks" contentTemplate's
 * default content).
 *
 * Pages through users with setLimit/setOffset (100 at a time) and saves after each page, rather
 * than loading the whole /users tree and doing one large session.save(), so a platform with a
 * large user base isn't loaded into memory -- or committed -- in one shot.
 */
def materializeDashboardTile(JCRNodeWrapper userNode) {
    if (userNode.hasNode("pagecontent/my-tasks/currentUserTasks")) {
        return false
    }

    JCRNodeWrapper pagecontent = userNode.hasNode("pagecontent")
            ? userNode.getNode("pagecontent")
            : userNode.addNode("pagecontent", "jnt:contentList")
    JCRNodeWrapper myTasks = pagecontent.hasNode("my-tasks")
            ? pagecontent.getNode("my-tasks")
            : pagecontent.addNode("my-tasks", "jnt:contentList")

    JCRNodeWrapper currentUserTasks = myTasks.addNode("currentUserTasks", "jnt:currentUserTasks")
    currentUserTasks.addMixin("jmix:renderable")
    currentUserTasks.setProperty("displayAssignee", true)
    currentUserTasks.setProperty("displayCreator", true)
    currentUserTasks.setProperty("displayState", true)
    currentUserTasks.setProperty("filterOnAssignee", "assignedToMeOrUnassigned")
    currentUserTasks.setProperty("filterOnStates", ["active", "started", "suspended"] as String[])
    currentUserTasks.setProperty("sortBy", "jcr:created")
    return true
}

def migrate(JCRSessionWrapper session) {
    int batchSize = 100
    int offset = 0
    int migrated = 0

    while (true) {
        QueryWrapper query = session.getWorkspace().getQueryManager().createQuery(
                "select * from [jnt:user] where isdescendantnode('/users') order by [jcr:uuid]", Query.JCR_SQL2)
        query.setLimit(batchSize)
        query.setOffset(offset)

        JCRNodeIteratorWrapper users = query.execute().getNodes()
        if (!users.hasNext()) {
            break
        }

        boolean changed = false
        int count = 0
        while (users.hasNext()) {
            JCRNodeWrapper userNode = (JCRNodeWrapper) users.nextNode()
            count++
            if ("guest".equals(userNode.getName())) {
                continue
            }
            if (materializeDashboardTile(userNode)) {
                changed = true
                migrated++
            }
        }
        if (changed) {
            session.save()
        }
        if (count < batchSize) {
            break
        }
        offset += batchSize
    }

    log.info("Tasks dashboard tile backfill: materialized the tile for {} existing user(s)", migrated)
    return null
}

JCRTemplate.getInstance().doExecuteWithSystemSession({ JCRSessionWrapper session -> migrate(session) } as JCRCallback)
